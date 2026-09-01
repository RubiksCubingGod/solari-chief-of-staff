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
) => Promise<{ ok: true; result: unknown }>;

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
  /** Every `sendMessage` so far, oldest first. */
  sent(): SentMessage[];
  /** Calls of one method, for asserting a transport registered itself. */
  callsTo(method: string): RecordedCall[];
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

  const stub: StubTransformer = async (_prev, method, payload, signal) => {
    calls.push({ method, payload: { ...payload } });
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
    sent: () =>
      calls
        .filter((call) => call.method === 'sendMessage')
        .map((call) => ({
          chatId: String(call.payload['chat_id']),
          text: String(call.payload['text']),
        })),
    callsTo: (method: string) => calls.filter((call) => call.method === method),
    clear: () => {
      calls.length = 0;
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
