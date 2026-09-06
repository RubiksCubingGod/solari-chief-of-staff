import { createHash, randomBytes } from 'node:crypto';

import { loginTokens, type Database } from '@chief-of-staff/db';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';

/**
 * Magic-link tokens: minted, digested, stored, and spent exactly once.
 */

/** The handle every query here runs on — what `app.db` is. */
type Db = Database['db'];

/**
 * 32 bytes of `randomBytes`. This value is the whole credential — anything
 * holding it becomes the user it was minted for — so it is drawn from the
 * CSPRNG and made long enough that guessing is not a strategy, rather than
 * being a short code somebody reads off a screen the way a binding code is.
 */
export const LOGIN_TOKEN_BYTES = 32;

export function generateLoginToken(): string {
  return randomBytes(LOGIN_TOKEN_BYTES).toString('base64url');
}

/**
 * The one-way digest the database holds instead of the token.
 *
 * A database that leaks must not also be a database that can mint working
 * links, and SHA-256 of a 256-bit random value is not reversible or guessable —
 * which is also why this is a plain digest rather than a password hash: there
 * is no low-entropy secret here for a slow KDF to protect. The digest is what
 * makes a tampered token refusable without any comparison logic of its own: a
 * token somebody edited simply digests to something no row carries.
 */
export function digestLoginToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface IssuedLoginToken {
  /** The secret that goes in the link, and nowhere else. */
  readonly token: string;
  readonly expiresAt: Date;
}

/** Mints a link for a user and records only what is needed to recognise it. */
export async function issueLoginToken(
  db: Db,
  userId: string,
  ttlMs: number,
  now: Date = new Date(),
): Promise<IssuedLoginToken> {
  const token = generateLoginToken();
  const expiresAt = new Date(now.getTime() + ttlMs);
  await db.insert(loginTokens).values({
    userId,
    tokenDigest: digestLoginToken(token),
    expiresAt,
  });
  return { token, expiresAt };
}

/**
 * Spends a token, and answers with the user it belonged to — or `undefined` if
 * it cannot be spent, for any reason at all.
 *
 * The whole of single use is the one statement below. Marking the row consumed
 * *is* the check: the `WHERE` clause admits only a row that is unspent and
 * unexpired, so two visits arriving together contend for the same row inside
 * Postgres and the loser updates nothing and gets no rows back. Reading the row
 * first and updating it afterwards would leave a window between the two in
 * which both visits saw an unspent token, which is precisely the race this has
 * to survive.
 *
 * `now()` is the database's clock rather than this process's, so two API
 * instances whose clocks disagree cannot disagree about whether a link expired.
 *
 * Every refusal is the same `undefined` — expired, already spent, tampered
 * with, never issued. The caller has nothing to tell a visitor beyond "that
 * link does not work", and anything more would describe somebody else's token.
 */
export async function consumeLoginToken(
  db: Db,
  token: string,
): Promise<string | undefined> {
  const [spent] = await db
    .update(loginTokens)
    .set({ consumedAt: sql`now()` })
    .where(
      and(
        eq(loginTokens.tokenDigest, digestLoginToken(token)),
        isNull(loginTokens.consumedAt),
        gt(loginTokens.expiresAt, sql`now()`),
      ),
    )
    .returning({ userId: loginTokens.userId });
  return spent?.userId;
}
