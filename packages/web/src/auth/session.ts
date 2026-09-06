import {
  ApiError,
  ApiUnreachableError,
  createApiClient,
  sessionCookieCredential,
  type AuthenticatedUser,
} from '../api-client';
import { API_BASE_URL_VARIABLE, loadWebConfig } from '../config';

/**
 * Who is asking, as the dashboard is allowed to know it.
 *
 * The dashboard holds no signing key and looks nothing up: it hands the cookie
 * it was given to the API and believes the answer. That is the same rule the
 * rest of this package lives by - the API is the only door - and it is the
 * stronger arrangement for auth in particular. A dashboard that could verify a
 * session locally would need the secret sessions are signed with, which is to
 * say it could mint one; and a signature that verifies still says nothing about
 * whether the account behind it still exists. Only the API can answer that.
 */

/** The cookie the API issues. Named here as well because the two never meet. */
export const SESSION_COOKIE_NAME = 'cos_session';

/**
 * Where an unauthenticated visitor is sent. Declared here rather than in the
 * middleware so that reading it does not drag `next/server` into a plain unit
 * test of this package's entry point.
 */
export const REQUEST_LINK_PATH = '/login';

/** The caller, as `GET /auth/session` describes them. */
export type Session = AuthenticatedUser;

/**
 * The API's origin, read as a named member rather than out of `process.env` as
 * an object.
 *
 * The guard runs in the middleware bundle, and that bundle only carries the
 * variables the compiler could see being asked for by name. `loadWebConfig()`
 * reads its environment through a computed key, which is exactly what a bundler
 * cannot follow, so the one value the guard needs is spelled out here and the
 * shared loader still does the validating.
 */
function apiBaseUrl(): string {
  return loadWebConfig({ [API_BASE_URL_VARIABLE]: process.env.API_BASE_URL }).apiBaseUrl;
}

/**
 * The session a request carries, or `undefined` when it carries none the API
 * recognises.
 *
 * Only a 401 becomes `undefined`. An API that is unreachable, or that failed,
 * has not said this visitor is signed out - it has said nothing - and turning
 * that into a redirect would send everybody to a sign-in page that cannot work
 * either, with no sign anywhere of what actually broke. That case is left to
 * propagate, which is a legible 500 rather than a confusing loop.
 */
export async function readSession(cookieHeader: string | undefined): Promise<Session | undefined> {
  // A request carrying no session cookie at all is answered without a round
  // trip. Most requests are that request - every visit from a signed-out
  // browser, and every asset it pulls - and asking the API to confirm the
  // absence of a cookie this process can already see is absent buys nothing.
  if (cookieHeader === undefined || !cookieHeader.includes(`${SESSION_COOKIE_NAME}=`)) {
    return undefined;
  }

  const client = createApiClient({
    baseUrl: apiBaseUrl(),
    // Verbatim, unread: the dashboard could not verify this if it tried.
    credential: sessionCookieCredential(cookieHeader),
  });

  try {
    return await client.session();
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 401) return undefined;
    throw error;
  }
}

/**
 * What a request lets the dashboard know about who is asking.
 *
 * Three answers rather than two, because "no session" and "no answer" are
 * different facts and the callers want different things done with them. The
 * middleware turns the first into a redirect and the second into a shrug; the
 * layout draws a signed-out shell for both, but only after the difference has
 * stopped being an exception it has to catch.
 */
export type SessionReading =
  | { readonly state: 'signed-in'; readonly session: Session }
  | { readonly state: 'signed-out' }
  | { readonly state: 'unverifiable' };

/**
 * `readSession`, with an unreachable API given a name instead of a stack.
 *
 * Only an unreachable API becomes `unverifiable`. A reachable API answering
 * with a failure has said something, and what it said is a defect worth the
 * legible 500 `readSession` already produces; an API that is not answering at
 * all is a condition every page in this package already knows how to draw.
 */
export async function readSessionReading(
  cookieHeader: string | undefined,
): Promise<SessionReading> {
  try {
    const session = await readSession(cookieHeader);
    return session === undefined ? { state: 'signed-out' } : { state: 'signed-in', session };
  } catch (error: unknown) {
    if (error instanceof ApiUnreachableError) return { state: 'unverifiable' };
    throw error;
  }
}
