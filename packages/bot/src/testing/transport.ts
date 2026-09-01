import type { Transformer } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';

/**
 * The no-network Telegram transport every CI proof in this sprint runs through.
 *
 * It is a grammY API transformer that answers calls instead of forwarding them,
 * so nothing here touches api.telegram.org: `bot.handleUpdate` drives messages
 * in, and every call the bot makes out is captured for assertion. This file is
 * source-only — excluded from the package build and from its exports — because
 * a test transport that shipped could be installed in production by accident,
 * and a bot that silently answers its own API calls is the worst possible
 * production failure.
 */

/** The abort signal grammY hands a transformer, taken from grammY's own type. */
type TransformerSignal = Parameters<Transformer>[3];

/**
 * What this transport actually is, before it is widened to grammY's signature.
 * A real `Transformer` is generic in the method it answers, so its response
 * type is whatever that method returns; this one answers every method with the
 * same stub, which no generic signature can describe. Writing that down here
 * means the body below is ordinarily type-checked and exactly one cast — the
 * one at the seam — is needed, rather than a cast per return.
 */
type StubTransformer = (
  prev: unknown,
  method: string,
  payload: Record<string, unknown>,
  signal: TransformerSignal,
) => Promise<StubResponse>;

/**
 * Either half of what grammY's client understands. The failing half matters:
 * an `ok: false` body is how a real Telegram refusal reaches grammY, so a test
 * that scripts one exercises the same `GrammyError` production would see rather
 * than a fabricated error object.
 */
type StubResponse =
  | { ok: true; result: unknown }
  | { ok: false; error_code: number; description: string };

/** How the next scripted `sendMessage` behaves. */
export type SendOutcome =
  | { readonly kind: 'ok' }
  /** Telegram answered with an error code, as it does for a blocked bot. */
  | { readonly kind: 'refused'; readonly errorCode: number; readonly description: string }
  /** Nothing answered at all, as when the socket dies mid-request. */
  | { readonly kind: 'unreachable'; readonly message: string };

export interface RecordedCall {
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

/** One outbound message, in the two fields assertions actually care about. */
export interface SentMessage {
  readonly chatId: string;
  readonly text: string;
}

export interface TestTransport {
  readonly transformer: Transformer;
  readonly calls: readonly RecordedCall[];
  /**
   * Every `sendMessage` that actually got through, oldest first. Scripted
   * failures are absent from this and present in `calls`, which is the
   * difference an outbound proof is about.
   */
  sent(): SentMessage[];
  /** Calls of one method, for asserting a transport registered itself. */
  callsTo(method: string): RecordedCall[];
  /**
   * Queues how the next sends behave, oldest first. Anything past the end of
   * the script succeeds, so a test scripts only the failures it is about.
   */
  scriptSends(...outcomes: readonly SendOutcome[]): void;
  /**
   * Makes every `getUpdates` answer with a Telegram refusal instead of an empty
   * batch. That is how a long poll ends for good — a revoked token, a webhook
   * still registered, a second process holding the same bot — and it is the one
   * failure a polling runtime cannot notice by itself, because it happens long
   * after `start()` has returned.
   */
  failPolling(errorCode: number, description: string): void;
  clear(): void;
}

export const TEST_BOT_INFO: UserFromGetMe = {
  id: 424_242,
  is_bot: true,
  first_name: 'Chief of Staff',
  username: 'chief_of_staff_test_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

export interface TestTransportOptions {
  /**
   * How long `getUpdates` waits before answering with nothing. A real long poll
   * blocks; answering instantly would spin the polling loop hot in a test that
   * only wants to prove the loop started.
   */
  readonly longPollMs?: number;
}

export function createTestTransport(options: TestTransportOptions = {}): TestTransport {
  const longPollMs = options.longPollMs ?? 25;
  const calls: RecordedCall[] = [];
  const delivered: SentMessage[] = [];
  const script: SendOutcome[] = [];
  let pollingFailure: { errorCode: number; description: string } | undefined;

  const stub: StubTransformer = async (_prev, method, payload, signal) => {
    calls.push({ method, payload: { ...payload } });
    if (method === 'sendMessage') {
      const outcome = script.shift() ?? { kind: 'ok' };
      if (outcome.kind === 'unreachable') throw new Error(outcome.message);
      if (outcome.kind === 'refused') {
        return { ok: false, error_code: outcome.errorCode, description: outcome.description };
      }
      delivered.push({ chatId: String(payload['chat_id']), text: String(payload['text']) });
    }
    if (method === 'getUpdates' && pollingFailure !== undefined) {
      return {
        ok: false,
        error_code: pollingFailure.errorCode,
        description: pollingFailure.description,
      };
    }
    return { ok: true, result: await resultFor(method, longPollMs, signal) };
  };
  // The one cast in this file, and the reason the file never ships: everything
  // above is a stub wearing grammY's signature.
  const transformer = stub as unknown as Transformer;

  return {
    transformer,
    get calls() {
      return calls;
    },
    sent: () => [...delivered],
    callsTo: (method: string) => calls.filter((call) => call.method === method),
    scriptSends: (...outcomes: readonly SendOutcome[]) => {
      script.push(...outcomes);
    },
    failPolling: (errorCode: number, description: string) => {
      pollingFailure = { errorCode, description };
    },
    clear: () => {
      calls.length = 0;
      delivered.length = 0;
      script.length = 0;
      pollingFailure = undefined;
    },
  };
}

async function resultFor(
  method: string,
  longPollMs: number,
  signal: TransformerSignal,
): Promise<unknown> {
  if (method === 'getUpdates') {
    await pause(longPollMs, signal);
    return [];
  }
  if (method === 'getMe') return TEST_BOT_INFO;
  if (method === 'sendMessage') {
    return {
      message_id: 1,
      date: 0,
      chat: { id: 0, type: 'private' },
    };
  }
  // setWebhook, deleteWebhook and friends all answer `true`.
  return true;
}

/** Resolves after `ms`, or as soon as the poll is aborted by `bot.stop()`. */
function pause(ms: number, signal: TransformerSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** A private text message, the shape almost every proof in this sprint sends. */
export function textUpdate(chatId: string, text: string, updateId = nextUpdateId()): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(chatId), type: 'private', first_name: 'Tester' },
      from: { id: Number(chatId), is_bot: false, first_name: 'Tester' },
      text,
    },
  };
}

let updateCounter = 0;
function nextUpdateId(): number {
  updateCounter += 1;
  return updateCounter;
}
