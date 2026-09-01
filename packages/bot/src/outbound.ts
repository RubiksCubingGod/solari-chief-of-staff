import { deliveries, users, type Delivery } from '@chief-of-staff/db';
import { eq } from 'drizzle-orm';

import type { BotDatabase } from './transcript.js';

/**
 * The single outbound door (spec `bot-io-runtime`).
 *
 * Nothing in this file knows what Telegram is. It resolves who a user is
 * reachable as, records that a message was owed, asks a `ChatSender` to deliver
 * it, and records what happened — which is the whole of what s7's reminders and
 * s9's alerts need, and none of what would tie them to a chat vendor. The one
 * module that does know grammY implements the port.
 */

/** What one attempt to reach a chat came back with. */
export type SendAttempt =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** Whether asking again could plausibly succeed. */
      readonly retryable: boolean;
      /** What to write down, in the words the transport used. */
      readonly reason: string;
    };

/** Putting text in a chat, reduced to the only thing this module needs. */
export interface ChatSender {
  send(chatId: string, text: string): Promise<SendAttempt>;
}

export interface SendRetryPolicy {
  /** Total attempts including the first, so 1 means no retry at all. */
  readonly attempts: number;
  /** The first pause; each further pause doubles it. */
  readonly backoffMs: number;
}

/**
 * Three attempts, a second apart and then two. A send usually fails because
 * Telegram was briefly busy, which one short pause fixes; anything still
 * failing after a few seconds is a fault worth recording rather than one worth
 * holding a caller open for.
 */
export const DEFAULT_SEND_RETRY_POLICY: SendRetryPolicy = { attempts: 3, backoffMs: 1000 };

/**
 * Raised when a user has no chat to deliver to. It is an error rather than a
 * failed delivery because nothing was attempted and nothing went wrong: the
 * caller asked to reach somebody who has never connected, and the honest answer
 * is to hand that fact back rather than to file it as a delivery that failed.
 */
export class NoBindingError extends Error {
  readonly userId: string;

  constructor(userId: string) {
    super(`User ${userId} has no Telegram chat bound, so there is nowhere to send to.`);
    this.name = 'NoBindingError';
    this.userId = userId;
  }
}

export interface SendToUserOptions {
  readonly db: BotDatabase;
  readonly sender: ChatSender;
  readonly retry?: SendRetryPolicy;
  /** Injected so the backoff is provable without waiting through it. */
  readonly wait?: (ms: number) => Promise<void>;
}

/**
 * Delivers `text` to `userId`, or records why it could not.
 *
 * Failure is a return value, not an exception, because the record is the point:
 * a notification that did not arrive is a fact about the system rather than a
 * bug in the caller, and s7 fanning reminders out to many users should not have
 * to wrap every one of them in a catch to keep going.
 */
export type SendToUser = (userId: string, text: string) => Promise<Delivery>;

export function createSendToUser(options: SendToUserOptions): SendToUser {
  const { db, sender } = options;
  const retry = options.retry ?? DEFAULT_SEND_RETRY_POLICY;
  const wait = options.wait ?? delay;

  return async (userId: string, text: string): Promise<Delivery> => {
    const chatId = await resolveChatId(db, userId);
    if (chatId === null) throw new NoBindingError(userId);

    // Written before the first attempt, so a process killed mid-send leaves a
    // row saying a message was owed rather than leaving nothing at all.
    const [pending] = await db.insert(deliveries).values({ userId, chatId, text }).returning();
    if (pending === undefined) throw new Error('the delivery was not recorded');

    let attempts = 0;
    let last: SendAttempt = NEVER_ATTEMPTED;
    while (attempts < retry.attempts) {
      // Between attempts only. Pausing after the last one would hold the caller
      // open for a retry that is not coming.
      if (attempts > 0) await wait(retry.backoffMs * 2 ** (attempts - 1));
      attempts += 1;
      last = await sender.send(chatId, text);
      if (last.ok || !last.retryable) break;
    }

    const [settled] = await db
      .update(deliveries)
      .set({
        status: last.ok ? 'sent' : 'failed',
        // Cleared on success even after a retry: a delivery that arrived has
        // nothing left to explain.
        error: last.ok ? null : last.reason,
        attempts,
        settledAt: new Date(),
      })
      .where(eq(deliveries.id, pending.id))
      .returning();
    if (settled === undefined) throw new Error('the delivery record vanished mid-send');
    return settled;
  };
}

/**
 * Stands in until the first attempt answers. A policy allowing no attempts is a
 * misconfiguration, and this makes it read as one in the record rather than
 * throwing somewhere the caller cannot see.
 */
const NEVER_ATTEMPTED: SendAttempt = {
  ok: false,
  retryable: false,
  reason: 'the retry policy allowed no attempts',
};

/** The chat a user is reachable as, or null when nobody has bound one. */
async function resolveChatId(db: BotDatabase, userId: string): Promise<string | null> {
  const [found] = await db
    .select({ chatId: users.telegramChatId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return found?.chatId ?? null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
