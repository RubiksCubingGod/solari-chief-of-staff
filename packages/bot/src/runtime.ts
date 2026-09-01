import type { IncomingMessage, ServerResponse } from 'node:http';

import { Bot, webhookCallback, type Context, type MiddlewareFn, type Transformer } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';

import type { BotConfig, BotTransport } from './config.js';
import { createRateLimiter, type RateLimiter } from './rate-limit.js';
import { recordMessage, type BotDatabase } from './transcript.js';

/**
 * What a chat that has run out of tokens is told, once per notice window. It
 * names the limit rather than blaming the sender: the usual cause is a retry
 * loop somewhere, not a person typing quickly.
 */
export const RATE_LIMIT_NOTICE =
  'You are sending messages faster than I can handle them. I have paused this chat for a moment — everything you send meanwhile is ignored, so please resend anything that mattered.';

export interface BotRuntime {
  /** The transport the configuration selected, before anything starts. */
  readonly transport: BotTransport;
  readonly bot: Bot;
  /**
   * The handler production mounts on the webhook route. Throws in polling
   * mode: a process that is long-polling has no webhook to serve, and
   * returning a handler that silently double-processes updates would be worse
   * than refusing.
   */
  webhookHandler(): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface BotRuntimeOptions {
  readonly config: BotConfig;
  readonly db: BotDatabase;
  /** Injected so the rate limiter's refill is provable without waiting for it. */
  readonly now?: () => number;
  /**
   * Installed closest to the network, so it answers calls instead of forwarding
   * them. Tests pass the test transport; production passes nothing.
   */
  readonly transformer?: Transformer;
  /** Supplied by tests so `init` does not have to call `getMe` over a network. */
  readonly botInfo?: UserFromGetMe;
}

/**
 * The one runtime every Telegram byte flows through.
 *
 * Both directions are captured at a single point each, which is what makes the
 * transcript complete by construction rather than by everyone remembering:
 * inbound in the first middleware, before the rate limiter can refuse anything,
 * and outbound in an API transformer, so a reply is recorded no matter which
 * handler sent it. Nothing outside this package imports grammY.
 */
export function createBotRuntime(options: BotRuntimeOptions): BotRuntime {
  const { config, db } = options;
  const bot =
    options.botInfo === undefined
      ? new Bot(config.token)
      : new Bot(config.token, { botInfo: options.botInfo });
  const limiter = createRateLimiter(config.rateLimit, options.now ?? Date.now);

  // Order matters twice over, in opposite directions, because grammY composes
  // its two pipelines the opposite way round.
  //
  // Transformers: the last one installed is the outermost, so the transcript
  // goes on last and every other transformer runs inside it. That is both what
  // makes it un-short-circuitable — a transport installed after it would answer
  // the call and the row would never be written — and the right seam anyway:
  // outside a future retry or throttle transformer, one message is one row
  // rather than one row per HTTP attempt.
  if (options.transformer !== undefined) bot.api.config.use(options.transformer);
  bot.api.config.use(transcribeOutbound(db));

  // Middleware: the first one installed runs first, so the transcript goes on
  // before the limiter and a refused message is still recorded as having
  // arrived.
  bot.use(transcribeInbound(db));
  bot.use(refuseFloods(limiter));

  return {
    transport: config.transport,
    bot,

    webhookHandler() {
      if (config.transport !== 'webhook') {
        throw new Error(
          `This runtime is configured for ${config.transport}, so it has no webhook handler.`,
        );
      }
      return config.webhookSecret === undefined
        ? webhookCallback(bot, 'http')
        : webhookCallback(bot, 'http', { secretToken: config.webhookSecret });
    },

    async start() {
      if (config.transport === 'webhook') {
        await bot.init();
        // Registering the URL is the whole of "starting" in webhook mode: from
        // here Telegram calls us, and the handler above is what answers.
        await bot.api.setWebhook(
          config.webhookUrl ?? '',
          config.webhookSecret === undefined ? {} : { secret_token: config.webhookSecret },
        );
        return;
      }
      // `bot.start()` resolves only once the bot is stopped, so awaiting it
      // here would mean start() never returns. The rejection is still routed:
      // an unhandled one would take the process down with no explanation.
      await bot.init();
      void bot.start().catch((error: unknown) => {
        bot.catch?.(error as never);
      });
    },

    async stop() {
      if (config.transport === 'webhook') return;
      await bot.stop();
    },
  };
}

/** Records every inbound text message, before anything can decide to refuse it. */
function transcribeInbound(db: BotDatabase): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const chatId = ctx.chat?.id;
    const text = ctx.message?.text;
    if (chatId !== undefined && text !== undefined) {
      await recordMessage(db, { chatId: String(chatId), direction: 'inbound', text });
    }
    await next();
  };
}

/**
 * Records every outbound message. This sits in the API layer rather than in a
 * middleware because replies are sent from many places — a handler, a refusal,
 * `sendToUser` in a later task — and only the API call is common to all of them.
 */
function transcribeOutbound(db: BotDatabase): Transformer {
  return async (prev, method, payload, signal) => {
    const response = await prev(method, payload, signal);
    if (method === 'sendMessage' && response.ok) {
      const fields = payload as unknown as { chat_id?: number | string; text?: string };
      if (fields.chat_id !== undefined && fields.text !== undefined) {
        await recordMessage(db, {
          chatId: String(fields.chat_id),
          direction: 'outbound',
          text: fields.text,
        });
      }
    }
    return response;
  };
}

/**
 * Refuses a chat that has spent its burst. The refused message is already in
 * the transcript by the time this runs, and the notice it may send is recorded
 * on the way out, so a flood is fully readable afterwards.
 */
function refuseFloods(limiter: RateLimiter): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) {
      await next();
      return;
    }
    const verdict = limiter.check(String(chatId));
    if (verdict.allowed) {
      await next();
      return;
    }
    if (verdict.notify) await ctx.reply(RATE_LIMIT_NOTICE);
    // Deliberately does not call next(): the message is dropped here, having
    // been recorded on the way in.
  };
}
