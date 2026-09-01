import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { ConfigError, type RuntimeEnvironment } from '../config.js';

/**
 * The session, and everything that decides what one is worth.
 *
 * A session is a signed statement — "this user, until this instant" — rather
 * than a row. Nothing about a logged-in user needs to be looked up, so nothing
 * has to be written on every request; the cost is that ending a session means
 * taking the cookie away rather than deleting a row, which is why the lifetime
 * below is hours instead of weeks.
 */

/** The cookie both the API and the dashboard read the session out of. */
export const SESSION_COOKIE_NAME = 'cos_session';

/** How long a session lasts before the holder has to ask for another link. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * How long an issued magic link lives. Long enough to leave the tab, find the
 * mail and come back; short enough that a link sitting in an inbox somebody
 * else can read is not a standing invitation.
 */
export const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;

/** Where the dashboard runs when nothing says otherwise — `pnpm dev` in packages/web. */
export const DEFAULT_DASHBOARD_BASE_URL = 'http://127.0.0.1:3001';

/**
 * Everything the auth flow needs from the environment.
 *
 * Deliberately not part of `AppConfig`: that is what the server needs to boot
 * and bind, this is what the identity seam needs to work, and keeping them
 * apart means replacing the seam again touches one directory. `loadConfig`
 * stays the only reader of the variables a deployment already sets.
 */
export interface AuthConfig {
  /** The HMAC key every session cookie is signed with. */
  readonly sessionSecret: string;
  /** The origin the magic link points at — this server, as a browser sees it. */
  readonly apiPublicUrl: string;
  /** The origin a consumed link lands on, and an unauthenticated page is sent to. */
  readonly dashboardBaseUrl: string;
  /** Set only where the API and the dashboard are on different hosts. */
  readonly cookieDomain: string | undefined;
  /** `Secure` on the cookie: always on in production, never on plain-http loopback. */
  readonly cookieSecure: boolean;
}

export const SESSION_SECRET_VARIABLE = 'SESSION_SECRET';
export const API_PUBLIC_URL_VARIABLE = 'API_PUBLIC_URL';
export const DASHBOARD_BASE_URL_VARIABLE = 'DASHBOARD_BASE_URL';
export const SESSION_COOKIE_DOMAIN_VARIABLE = 'SESSION_COOKIE_DOMAIN';

function trimmed(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = environment[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/u, '');
}

export interface AuthConfigSource {
  readonly host: string;
  readonly port: number;
  readonly runtimeEnvironment: RuntimeEnvironment;
}

/**
 * Reads the auth configuration out of an environment object.
 *
 * The secret is required in production and generated per boot anywhere else.
 * That is not a convenience: a workstation that had to invent a secret before
 * it could run the server would have every developer paste the same one into
 * the same file, and a shared development secret is worth less than none. A
 * generated one means restarting the dev server signs everybody out, which is
 * the honest consequence of nobody having configured a secret. In production
 * the same absence is a refusal, because there it would mean every deploy
 * signed out every user — and two instances behind a load balancer would each
 * reject the other's cookies.
 */
export function loadAuthConfig(
  environment: NodeJS.ProcessEnv,
  source: AuthConfigSource,
): AuthConfig {
  const problems: string[] = [];
  const configured = trimmed(environment, SESSION_SECRET_VARIABLE);
  if (configured === undefined && source.runtimeEnvironment === 'production') {
    problems.push(`${SESSION_SECRET_VARIABLE} is required when NODE_ENV is production`);
  }
  if (problems.length > 0) throw new ConfigError(problems);

  // `0.0.0.0` is what a server binds, never an address a browser can follow, so
  // a link built from it would arrive unclickable.
  const reachableHost =
    source.host === '0.0.0.0' || source.host === '::' ? '127.0.0.1' : source.host;

  return {
    sessionSecret: configured ?? randomBytes(32).toString('hex'),
    apiPublicUrl: withoutTrailingSlash(
      trimmed(environment, API_PUBLIC_URL_VARIABLE) ??
        `http://${reachableHost}:${String(source.port)}`,
    ),
    dashboardBaseUrl: withoutTrailingSlash(
      trimmed(environment, DASHBOARD_BASE_URL_VARIABLE) ?? DEFAULT_DASHBOARD_BASE_URL,
    ),
    cookieDomain: trimmed(environment, SESSION_COOKIE_DOMAIN_VARIABLE),
    cookieSecure: source.runtimeEnvironment === 'production',
  };
}

interface SessionClaims {
  /** The user this session speaks for. */
  readonly uid: string;
  /** Expiry, as whole seconds since the epoch. */
  readonly exp: number;
}

function base64url(value: Buffer): string {
  return value.toString('base64url');
}

function sign(payload: string, secret: string): string {
  return base64url(createHmac('sha256', secret).update(payload).digest());
}

/**
 * A session token: the claims, then the signature over exactly those bytes.
 *
 * The claims are readable by anyone holding the token, which is fine — they say
 * nothing the holder does not already know. What they cannot do is change them,
 * because the signature is over the encoded payload rather than over the values
 * parsed out of it, so there is no re-encoding step for a forgery to exploit.
 */
export function signSession(userId: string, secret: string, expiresAt: Date): string {
  const claims: SessionClaims = { uid: userId, exp: Math.floor(expiresAt.getTime() / 1000) };
  const payload = base64url(Buffer.from(JSON.stringify(claims), 'utf8'));
  return `${payload}.${sign(payload, secret)}`;
}

function signaturesMatch(expected: string, presented: string): boolean {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(presented, 'utf8');
  // `timingSafeEqual` throws on a length mismatch rather than returning false,
  // and the length of a signature is not a secret, so it is checked first.
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The user a token speaks for, or `undefined` if it does not speak for anyone.
 *
 * Every refusal is the same `undefined`: a garbage cookie, a truncated one, one
 * signed with another secret and one that simply expired are all "not signed
 * in". A caller that told them apart would be handing an attacker a way to ask
 * which of its guesses was closest.
 */
export function verifySessionToken(
  token: string | undefined,
  secret: string,
  now: Date = new Date(),
): string | undefined {
  if (token === undefined) return undefined;
  const separator = token.indexOf('.');
  if (separator <= 0) return undefined;
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!signaturesMatch(sign(payload, secret), signature)) return undefined;

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof claims !== 'object' || claims === null) return undefined;
  const { uid, exp } = claims as Partial<SessionClaims>;
  if (typeof uid !== 'string' || uid === '' || typeof exp !== 'number') return undefined;
  if (exp * 1000 <= now.getTime()) return undefined;
  return uid;
}

export interface CookieAttributes {
  readonly domain?: string | undefined;
  readonly secure?: boolean | undefined;
  /** Seconds. Zero clears the cookie. */
  readonly maxAgeSeconds: number;
}

/**
 * A `Set-Cookie` value for the session.
 *
 * `HttpOnly` because no script has any business reading it — an XSS bug should
 * not also be an account takeover. `SameSite=Lax` because the dashboard and the
 * API are the same site and nothing else should be able to spend the session on
 * a cross-site request. `Path=/` because the guard covers every page.
 */
export function sessionCookieHeader(value: string, attributes: CookieAttributes): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${String(attributes.maxAgeSeconds)}`,
  ];
  if (attributes.domain !== undefined) parts.push(`Domain=${attributes.domain}`);
  if (attributes.secure === true) parts.push('Secure');
  return parts.join('; ');
}

/**
 * The `Set-Cookie` that ends a session. The value is emptied as well as
 * expired, so a client that ignores `Max-Age` still holds nothing that verifies.
 */
export function clearedSessionCookieHeader(
  attributes: Omit<CookieAttributes, 'maxAgeSeconds'>,
): string {
  return sessionCookieHeader('', { ...attributes, maxAgeSeconds: 0 });
}

/** One cookie out of a request's `Cookie` header, or `undefined` if it is not there. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() !== name) continue;
    return pair.slice(separator + 1).trim();
  }
  return undefined;
}

/**
 * A `Cookie` request-header value carrying a valid session for `userId`.
 *
 * This exists for the integration tests of packages that drive a real API
 * server — `packages/api` itself, and any package whose suite boots
 * `createApp` and needs to act as somebody. Before this task the same packages
 * sent an `x-user-id` header, which was removed because a header a caller
 * chooses is a header a caller can lie in; this is the supported replacement,
 * and it is one line at a call site:
 *
 * ```ts
 * const headers = { cookie: mintSessionCookie(userId, SESSION_SECRET) };
 * ```
 *
 * It is deliberately not a production credential path. Minting a session
 * without consuming a link is exactly what the magic-link flow exists to
 * prevent, so the only thing that may call this is a test that already knows
 * the server's own secret because it configured it.
 */
export function mintSessionCookie(
  userId: string,
  secret: string,
  ttlMs: number = SESSION_TTL_MS,
): string {
  const token = signSession(userId, secret, new Date(Date.now() + ttlMs));
  return `${SESSION_COOKIE_NAME}=${token}`;
}
