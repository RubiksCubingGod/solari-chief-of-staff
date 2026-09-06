import { isBindingCode, normalizeBindingCode } from '@chief-of-staff/core';
import { bindingCodes, users } from '@chief-of-staff/db';
import { eq } from 'drizzle-orm';

import type { BotDatabase } from './transcript.js';

/**
 * Redeeming a one-time code (ARCHITECTURE §10). The API issues codes; this
 * spends them. It is the only place a chat id is ever written to a user row,
 * which is what makes "who is this chat" a question with one answer.
 */

export interface BindChatRequest {
  readonly chatId: string;
  /** As typed, not as issued — normalization happens here. */
  readonly code: string;
  /** Injected so expiry is provable without waiting for it. */
  readonly now?: Date;
}

export type BindingResult =
  | { readonly outcome: 'bound'; readonly userId: string }
  | { readonly outcome: 'already-bound'; readonly userId: string }
  | { readonly outcome: 'unknown-code' }
  | { readonly outcome: 'expired' }
  | { readonly outcome: 'consumed' }
  | { readonly outcome: 'chat-bound-elsewhere' }
  | { readonly outcome: 'user-bound-elsewhere' };

export type BindingOutcome = BindingResult['outcome'];

/**
 * Spends a code and binds a chat, or refuses and spends nothing.
 *
 * Both writes happen in one transaction, so there is no instant at which a code
 * is spent and the chat is not bound. That ordering is not a nicety: a code
 * burned without a binding leaves somebody holding a code that no longer works
 * and no way to get in without an operator, which is the worst outcome
 * available to this function and the one it is built to make impossible.
 *
 * The code row is locked for the duration, so two `/start`s racing with the
 * same code cannot both find it unconsumed.
 */
export async function bindChat(
  db: BotDatabase,
  request: BindChatRequest,
): Promise<BindingResult> {
  const now = request.now ?? new Date();
  const code = normalizeBindingCode(request.code);
  // A malformed code is refused before any query runs, and refused in the same
  // words as a well-formed code that does not exist.
  if (!isBindingCode(code)) return { outcome: 'unknown-code' };

  return db.transaction(async (tx) => {
    const [issued] = await tx
      .select()
      .from(bindingCodes)
      .where(eq(bindingCodes.code, code))
      .for('update')
      .limit(1);
    if (issued === undefined) return { outcome: 'unknown-code' };
    // Consumed before expired: a code the holder already used should be told it
    // was used, not that it aged out, whichever happened first.
    if (issued.consumedAt !== null) return { outcome: 'consumed' };
    if (issued.expiresAt.getTime() <= now.getTime()) return { outcome: 'expired' };

    const [occupant] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.telegramChatId, request.chatId))
      .limit(1);
    // Somebody else's chat. Refused without spending the code, because the
    // person who holds it did nothing wrong and should not lose it to a chat
    // they cannot use.
    if (occupant !== undefined && occupant.id !== issued.userId) {
      return { outcome: 'chat-bound-elsewhere' };
    }

    const [owner] = await tx
      .select({ telegramChatId: users.telegramChatId })
      .from(users)
      .where(eq(users.id, issued.userId))
      .limit(1);
    if (
      owner?.telegramChatId !== null &&
      owner?.telegramChatId !== undefined &&
      owner.telegramChatId !== request.chatId
    ) {
      // The account already lives in another chat. Moving it here on a code
      // alone is the same silent rebind refused above, seen from the other end.
      return { outcome: 'user-bound-elsewhere' };
    }

    await tx.update(bindingCodes).set({ consumedAt: now }).where(eq(bindingCodes.id, issued.id));
    if (occupant !== undefined) {
      // Already bound, to this same user. The code is still spent: it was sent,
      // and a code that survives being sent is one somebody else could send.
      return { outcome: 'already-bound', userId: issued.userId };
    }
    await tx
      .update(users)
      .set({ telegramChatId: request.chatId })
      .where(eq(users.id, issued.userId));
    return { outcome: 'bound', userId: issued.userId };
  });
}
