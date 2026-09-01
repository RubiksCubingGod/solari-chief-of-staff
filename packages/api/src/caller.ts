import { users } from '@chief-of-staff/db';
import { eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';

import { SESSION_COOKIE_NAME, readCookie, verifySessionToken } from './auth/session.js';
import { HttpError } from './errors.js';

/**
 * Who a request is from.
 *
 * This used to be an `x-user-id` header, on the understanding recorded here at
 * the time: the identity is deliberately not part of any request body, so when
 * real authentication landed it would replace this hook alone and every route
 * schema would stay exactly as it is. That is what happened. The header is
 * gone — a caller-chosen header is a caller-chosen identity, which in
 * production is not authentication at all — and the session cookie
 * `packages/api/src/routes/auth.ts` issues took its place. No fallback to the
 * header remains, deliberately: one would let anybody claim any user id.
 */

/**
 * Declared on every route that acts for somebody, exactly as the header schema
 * it replaced was. It requires nothing, and cannot: a signature is not a shape,
 * so no JSON Schema can decide whether a session is real. A request arriving
 * with no cookie is unauthenticated (401) rather than malformed (400), which is
 * what a browser that has simply not logged in yet deserves to be told.
 */
export const callerHeaderSchema = {
  type: 'object',
  properties: { cookie: { type: 'string' } },
} as const;

/**
 * Resolves the session cookie to a user that exists.
 *
 * Checking the user here rather than letting a foreign key fail means a session
 * for a deleted account is refused identically whether the route reads or
 * writes, and a refused write never reaches an INSERT. A valid signature over a
 * user who is gone is still refused: the cookie outlives the row, and the row
 * is the authority.
 *
 * Both refusals are the same 401 with the same wording. Telling "that
 * signature is wrong" apart from "that user no longer exists" would answer a
 * question the holder of a forged cookie has no business asking.
 */
export async function resolveCaller(request: FastifyRequest): Promise<void> {
  const token = readCookie(request.headers.cookie, SESSION_COOKIE_NAME);
  const userId = verifySessionToken(token, request.server.auth.sessionSecret);
  if (userId === undefined) throw unauthenticated();

  const found = await request.server.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (found.length === 0) throw unauthenticated();
  request.userId = userId;
}

function unauthenticated(): HttpError {
  return new HttpError(
    401,
    'unauthorized',
    'This request carries no valid session. Request a link at /auth/request-link.',
  );
}
