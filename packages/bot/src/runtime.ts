import type { IncomingMessage, ServerResponse } from 'node:http';

import type { JobHarness } from '@chief-of-staff/db';
import {
  Bot,
  GrammyError,
  webhookCallback,
  type Context,
  type MiddlewareFn,
  type Transformer,
} from 'grammy';
import type { Message, UserFromGetMe } from 'grammy/types';

import { bindChat, type BindingOutcome } from './binding.js';
import type { BotConfig, BotTransport } from './config.js';
import { createNoticeGate, type NoticeGate } from './notice-gate.js';
import {
  createSendToUser,
  type ChatSender,
  type SendAttempt,
  type SendRetryPolicy,
  type SendToUser,
} from './outbound.js';
import { createRateLimiter, type RateLimiter } from './rate-limit.js';
import {
  BINDING_ALREADY_DONE,
  BINDING_CHAT_TAKEN,
  BINDING_CODE_CONSUMED,
  BINDING_CODE_EXPIRED,
  BINDING_CODE_UNKNOWN,
  BINDING_CONFIRMED,
  BINDING_USER_TAKEN,
  HOW_TO_BIND,
  RATE_LIMIT_NOTICE,
  TEXT_ONLY,
} from './replies.js';
import {
  createLedgerAnswerSink,
  routeMessage,
  type AnswerSink,
  type ChatLoop,
  type RouteMessageOptions,
} from './routing.js';
import { recordMessage, resolveUserId, type BotDatabase } from './transcript.js';

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
  /**
   * The single outbound door. Later sprints deliver reminders and alerts
   * through this rather than reaching for `bot.api` themselves, which is what
   * keeps every outbound message both transcribed and accounted for.
   */
  readonly sendToUser: SendToUser;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface BotRuntimeOptions {
  readonly config: BotConfig;
  readonly db: BotDatabase;
  /**
   * Where an ordinary message goes. Required rather than defaulted: a runtime
   * with nowhere to send a request would take every message a bound user sends
   * and answer none of them, and it would do it silently.
   */
  readonly chatLoop: ChatLoop;
  /**
   * Where an answer to a pending question goes. Defaults to the task ledger
   * over `db` and `harness`, which is what production wants; tests pass their
   * own to watch what arrives.
   */
  readonly answerSink?: AnswerSink;
  /**
   * The harness an answered task is queued to run on. Required unless an
   * `answerSink` is supplied: a reply the runtime recorded but could not
   * queue the task for would park the job forever with its answer beside it.
   */
  readonly harness?: JobHarness;
  /** Injected so the rate limiter's refill is provable without waiting for it. */
  readonly now?: () => number;
  /**
   * Installed closest to the network, so it answers calls instead of forwarding
   * them. Tests pass the test transport; production passes nothing.
   */
  readonly transformer?: Transformer;
  /** Supplied by tests so `init` does not have to call `getMe` over a network. */
  readonly botInfo?: UserFromGetMe;
  /** How hard a failed delivery is retried; defaults to the policy in `outbound.ts`. */
  readonly sendRetry?: SendRetryPolicy;
  /** Injected so delivery backoff is provable without waiting through it. */
  readonly wait?: (ms: number) => Promise<void>;
  /**
   * Where a long poll that dies gets reported. Defaults to `logPollingFailure`;
   * a process that has somewhere better to send an outage passes that instead.
   */
  readonly onPollingFailure?: (error: unknown) => void;
  /**
   * Where one update that failed gets reported. Defaults to
   * `logUpdateFailure`. Separate from `onPollingFailure` because the two ask
   * different things of whoever reads them: one update failing is a chat to
   * look into, the poll dying is a bot to restart.
   */
  readonly onUpdateFailure?: (error: unknown) => void;
}

/**
 * The production sink: the ledger's, over the runtime's database and the
 * harness it was given. A runtime with neither a harness nor a sink of its
 * own is refused at construction rather than at the first answer, because
 * the first answer is a person's, and "recorded but never acted on" is the
 * failure this bot exists to prevent.
 */
function ledgerAnswerSink(options: BotRuntimeOptions, now: () => number): AnswerSink {
  if (options.harness === undefined) {
    throw new Error(
      'the bot runtime needs a job harness to queue answered tasks on, or an answer sink of its own',
    );
  }
  return createLedgerAnswerSink({ db: options.db, harness: options.harness }, () => new Date(now()));
}

/**
 * The default report for a long poll that stopped.
 *
 * This failure is the one nobody is awaiting: polling starts and `start()`
 * returns, so when the token is revoked, a webhook gets registered underneath
 * us, or a second process claims the same bot, there is no caller left to
 * reject and no request left to fail. Unreported it is the worst kind of
 * outage — the process stays up, healthy by every other measure, and simply
 * stops hearing anyone. Shaped like `logPoolError` in `@chief-of-staff/db`,
 * which exists for exactly the same reason on the other side of the system.
 */
/**
 * The default report for one update that failed partway through.
 *
 * Installing any handler at all is what keeps the bot alive: grammY rethrows
 * an unhandled middleware error, and out of the polling loop that rejection
 * ends the loop — so a single chat the bot cannot reply to, a user who blocked
 * it or a chat that was deleted, would stop every other chat being heard. The
 * error is reported rather than swallowed for the obvious reason, and only its
 * message is written: a grammY error carries the request that produced it, and
 * that request is authenticated with the bot token.
 */
export function logUpdateFailure(
  error: unknown,
  write: (line: string) => void = (line) => {
    console.error(line);
  },
): void {
  write(`[bot] update failed: ${error instanceof Error ? error.message : String(error)}`);
}

export function logPollingFailure(
  error: unknown,
  write: (line: string) => void = (line) => {
    console.error(line);
  },
): void {
  write(`[bot] long polling stopped: ${error instanceof Error ? error.message : String(error)}`);
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
  const now = options.now ?? Date.now;
  const reportPollingFailure = options.onPollingFailure ?? logPollingFailure;
  const reportUpdateFailure = options.onUpdateFailure ?? logUpdateFailure;
  const limiter = createRateLimiter(config.rateLimit, now);

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
  bot.use(redeemStart(db));
  bot.use(requireBinding(db, createNoticeGate(config.rateLimit.noticeWindowMs, now)));
  // Last, and it calls no `next()`: past here the message has a destination,
  // and anything installed after this would be a second one.
  bot.use(
    route(db, {
      chatLoop: options.chatLoop,
      answerSink: options.answerSink ?? ledgerAnswerSink(options, now),
    }),
  );

  // Installed last, over a finished chain: from here an update that throws is
  // reported and the bot carries on, rather than taking the polling loop down
  // with it. Nothing about the failing update is recovered — the reply that
  // could not be sent stays unsent — because there is nowhere left to send it.
  bot.catch((error) => {
    reportUpdateFailure(error);
  });

  return {
    transport: config.transport,
    bot,
    // Sends through `bot.api`, so a delivery crosses the same transformer
    // stack a reply does and is transcribed by the same one row of code.
    sendToUser: outboundOver(bot, db, options),

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
      // here would mean start() never returns. That leaves its rejection with
      // nobody to reject to, which is why it is handed to the reporter: it is
      // the only news that the poll died, and it arrives long after this
      // method answered that the bot was up.
      await bot.init();
      void bot.start().catch(reportPollingFailure);
    },

    async stop() {
      if (config.transport === 'webhook') return;
      await bot.stop();
    },
  };
}

export interface TelegramOutboundOptions {
  readonly config: BotConfig;
  readonly db: BotDatabase;
  /** Installed closest to the network; tests pass the test transport, production nothing. */
  readonly transformer?: Transformer;
  readonly sendRetry?: SendRetryPolicy;
  readonly wait?: (ms: number) => Promise<void>;
}

/**
 * The outbound door on its own, for a process that sends but does not listen.
 *
 * The worker delivers reminders and puts questions in front of people, and it
 * must not also poll for updates: two processes long-polling one token is
 * how Telegram hands each of them half the conversation. So it gets a `Bot`
 * with the same transformer stack as the runtime's - transcript outermost -
 * and none of the middleware, and never calls `start()`. The Bot API needs
 * no `init` to send, only to receive.
 */
export function createTelegramOutbound(options: TelegramOutboundOptions): SendToUser {
  const bot = new Bot(options.config.token);
  if (options.transformer !== undefined) bot.api.config.use(options.transformer);
  bot.api.config.use(transcribeOutbound(options.db));
  return outboundOver(bot, options.db, options);
}

function outboundOver(
  bot: Bot,
  db: BotDatabase,
  options: Pick<BotRuntimeOptions, 'sendRetry' | 'wait'>,
): SendToUser {
  return createSendToUser({
    db,
    sender: telegramSender(bot),
    ...(options.sendRetry === undefined ? {} : { retry: options.sendRetry }),
    ...(options.wait === undefined ? {} : { wait: options.wait }),
  });
}

/**
 * The `ChatSender` port, over grammY. It is here rather than in `outbound.ts`
 * because deciding whether a failure is worth retrying means reading Telegram's
 * own error vocabulary, and this file is the only one allowed to know it.
 */
function telegramSender(bot: Bot): ChatSender {
  return {
    async send(chatId: string, text: string): Promise<SendAttempt> {
      try {
        await bot.api.sendMessage(chatId, text);
        return { ok: true };
      } catch (error: unknown) {
        return classifySendFailure(error);
      }
    },
  };
}

function classifySendFailure(error: unknown): SendAttempt {
  if (error instanceof GrammyError) {
    // Telegram answered, and its own code says whether asking again could help.
    // 429 means slow down and 5xx means not right now; a 400 or a 403 is a fact
    // about this chat that an identical second request cannot change, and
    // spending the budget on it delays every delivery queued behind it.
    const retryable = error.error_code === 429 || error.error_code >= 500;
    return { ok: false, retryable, reason: `${error.error_code}: ${error.description}` };
  }
  // Nothing answered at all - a socket, a DNS failure, a timeout. That is the
  // case a second attempt exists for.
  return {
    ok: false,
    retryable: true,
    reason: error instanceof Error ? error.message : String(error),
  };
}

/** What each binding outcome is answered with. */
const BINDING_REPLIES: Readonly<Record<BindingOutcome, string>> = {
  bound: BINDING_CONFIRMED,
  'already-bound': BINDING_ALREADY_DONE,
  'unknown-code': BINDING_CODE_UNKNOWN,
  expired: BINDING_CODE_EXPIRED,
  consumed: BINDING_CODE_CONSUMED,
  'chat-bound-elsewhere': BINDING_CHAT_TAKEN,
  'user-bound-elsewhere': BINDING_USER_TAKEN,
};

/**
 * Handles `/start`, the one thing an unbound chat is allowed to do. A bare
 * `/start` is not a failed redemption but somebody who has just opened the
 * chat, so it gets the instructions rather than a refusal.
 */
function redeemStart(db: BotDatabase): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const text = ctx.message?.text;
    const chatId = ctx.chat?.id;
    if (text === undefined || chatId === undefined || !/^\/start(@\S+)?(\s|$)/u.test(text)) {
      await next();
      return;
    }
    const code = text.replace(/^\/start(@\S+)?/u, '').trim();
    if (code === '') {
      await ctx.reply(HOW_TO_BIND);
      return;
    }
    const result = await bindChat(db, { chatId: String(chatId), code });
    await ctx.reply(BINDING_REPLIES[result.outcome]);
    // Redemption is the whole of this message either way. Passing an accepted
    // `/start` on would hand the tool loop the code as if it were a request.
  };
}

/**
 * The authorization boundary. Nothing downstream runs for a chat that is bound
 * to nobody, so no later handler has to remember to check — a chat that reaches
 * past here has a user.
 */
function requireBinding(db: BotDatabase, gate: NoticeGate): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    if ((await resolveUserId(db, String(chatId))) !== null) {
      await next();
      return;
    }
    // Told how to bind at most once per window. Refusing is unconditional;
    // only the explanation is rationed, or a script talking to an unbound chat
    // would get one reply per message forever.
    if (gate.due(String(chatId))) await ctx.reply(HOW_TO_BIND);
  };
}

/**
 * The last middleware: hands the message to the router and says whatever comes
 * back. The router itself is transport-free, so this is the one place a routed
 * reply becomes a Telegram call.
 */
function route(db: BotDatabase, options: RouteMessageOptions): MiddlewareFn<Context> {
  return async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const text = ctx.message?.text;
    if (text === undefined) {
      // A message this sprint cannot read, and text is the whole of what it
      // can. It is answered rather than dropped because the alternative is
      // silence in a chat that answers everything else, which reads as a bot
      // that has died: the sender waits for a reply instead of retyping.
      // Updates carrying no message at all — edits, channel posts — are not
      // messages anybody is waiting on and get nothing.
      if (ctx.message !== undefined) await ctx.reply(TEXT_ONLY);
      return;
    }
    await ctx.reply(await routeMessage(db, options, { chatId: String(chatId), text }));
  };
}

/**
 * Records every inbound message before anything can decide to refuse it,
 * including the ones nothing downstream can read. A photo left out of the
 * transcript is a conversation with a hole in it, and the hole sits exactly
 * where somebody would look to find out why they never got an answer.
 */
function transcribeInbound(db: BotDatabase): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const chatId = ctx.chat?.id;
    const message = ctx.message;
    if (chatId !== undefined && message !== undefined) {
      await recordMessage(db, {
        chatId: String(chatId),
        direction: 'inbound',
        text: message.text ?? `[${inboundKind(message)}]`,
      });
    }
    await next();
  };
}

/**
 * Telegram's own name for whatever arrived, when it was not text.
 *
 * The transcript column holds text, so a photo has to be written down as
 * something. A bracketed kind is unmistakably a marker rather than words a
 * person typed, which neither an empty string nor a caption would be.
 */
const NON_TEXT_KINDS = [
  'photo',
  'voice',
  'audio',
  'video',
  'video_note',
  'animation',
  'document',
  'sticker',
  'location',
  'contact',
  'poll',
  'dice',
  'venue',
] as const satisfies readonly (keyof Message)[];

function inboundKind(message: Message): string {
  return NON_TEXT_KINDS.find((kind) => message[kind] !== undefined) ?? 'message';
}

/**
 * Records every outbound message. This sits in the API layer rather than in a
 * middleware because replies are sent from many places — a handler, a refusal,
 * `sendToUser` — and only the API call is common to all of them.
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
