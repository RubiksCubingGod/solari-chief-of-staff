import { deliveries, users, type Delivery } from '@chief-of-staff/db';
import { and, eq } from 'drizzle-orm';

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

export interface SendOptions {
  /**
   * The identity of the message, for a caller that may say the same thing
   * twice - the watch engine's notifier port is at-least-once. One key is one
   * delivery: a second send under a key that was sent, or is being sent, gets
   * that delivery back and touches nothing; a key whose delivery failed is
   * tried again on the same row, so the record shows every attempt it took.
   * An unkeyed send is its own delivery every time.
   */
  readonly dedupKey?: string;
}

/**
 * Delivers `text` to `userId`, or records why it could not.
 *
 * Failure is a return value, not an exception, because the record is the point:
 * a notification that did not arrive is a fact about the system rather than a
 * bug in the caller, and s7 fanning reminders out to many users should not have
 * to wrap every one of them in a catch to keep going.
 */
export type SendToUser = (userId: string, text: string, options?: SendOptions) => Promise<Delivery>;

export function createSendToUser(options: SendToUserOptions): SendToUser {
  const { db, sender } = options;
  const retry = options.retry ?? DEFAULT_SEND_RETRY_POLICY;
  const wait = options.wait ?? delay;

  return async (userId: string, text: string, send: SendOptions = {}): Promise<Delivery> => {
    const chatId = await resolveChatId(db, userId);
    if (chatId === null) throw new NoBindingError(userId);

    // Written before the first attempt, so a process killed mid-send leaves a
    // row saying a message was owed rather than leaving nothing at all.
    const reserved = await reserve(db, { userId, chatId, text }, send.dedupKey);
    if (reserved.kind === 'delivered') return reserved.delivery;
    const pending = reserved.delivery;

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
        attempts: pending.attempts + attempts,
        settledAt: new Date(),
      })
      .where(eq(deliveries.id, pending.id))
      .returning();
    if (settled === undefined) throw new Error('the delivery record vanished mid-send');
    return settled;
  };
}

type Reservation =
  /** A row of ours to send on, with the attempts already on it. */
  | { readonly kind: 'reserved'; readonly delivery: Delivery }
  /** Somebody already sent, or is sending, this key: nothing to do. */
  | { readonly kind: 'delivered'; readonly delivery: Delivery };

/**
 * The row a send is recorded on. Unkeyed, always a new one. Keyed, the row
 * for that key: new when there was none, reused when the earlier send failed
 * (set back to pending, so a process killed mid-retry leaves the same honest
 * row), and handed back untouched when it was sent or is still pending. The
 * unique index on the key is what makes two sends of one key one row even
 * when they arrive together.
 */
async function reserve(
  db: BotDatabase,
  values: { readonly userId: string; readonly chatId: string; readonly text: string },
  dedupKey: string | undefined,
): Promise<Reservation> {
  if (dedupKey === undefined) {
    const [inserted] = await db.insert(deliveries).values(values).returning();
    if (inserted === undefined) throw new Error('the delivery was not recorded');
    return { kind: 'reserved', delivery: inserted };
  }
  const [inserted] = await db
    .insert(deliveries)
    .values({ ...values, dedupKey })
    .onConflictDoNothing({ target: deliveries.dedupKey })
    .returning();
  if (inserted !== undefined) return { kind: 'reserved', delivery: inserted };
  // Only a failed delivery is ours to retry, and only if nobody else has
  // picked it up in the meantime: the conditional update is the claim.
  const [retried] = await db
    .update(deliveries)
    .set({ status: 'pending', error: null, settledAt: null })
    .where(and(eq(deliveries.dedupKey, dedupKey), eq(deliveries.status, 'failed')))
    .returning();
  if (retried !== undefined) return { kind: 'reserved', delivery: retried };
  const [existing] = await db.select().from(deliveries).where(eq(deliveries.dedupKey, dedupKey)).limit(1);
  if (existing === undefined) throw new Error(`the delivery under key ${dedupKey} vanished before it was read`);
  return { kind: 'delivered', delivery: existing };
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
