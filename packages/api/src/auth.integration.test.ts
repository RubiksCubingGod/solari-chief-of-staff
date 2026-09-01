import { randomUUID } from 'node:crypto';

import { loginTokens, runMigrations, users } from '@chief-of-staff/db';
import { startTestPostgres, type TestPostgres } from '@chief-of-staff/db/testing';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import type { RecordingMailer } from './auth/mailer.js';
import {
  SESSION_COOKIE_NAME,
  mintSessionCookie,
  signSession,
} from './auth/session.js';
import { digestLoginToken } from './auth/tokens.js';

/**
 * The dashboard's front door, proven against a real server and a real database.
 *
 * Everything here goes through HTTP rather than through the functions the
 * routes call, because the properties that matter are properties of the
 * exchange: what a stranger can learn from a response, what a browser is left
 * holding, and what happens when two visits arrive at once.
 */

const SESSION_SECRET = 'the-secret-only-this-suite-configured';
const API_PUBLIC_URL = 'http://api.test';
const DASHBOARD_BASE_URL = 'http://dashboard.test';

const OWNER_EMAIL = 'owner@example.test';
const STRANGER_EMAIL = 'stranger@example.test';
/** A syntactically fine address that belongs to no row. */
const NOBODY_EMAIL = 'nobody@example.test';

let postgres: TestPostgres;
let app: FastifyInstance;
let mailer: RecordingMailer;
let ownerId: string;
let strangerId: string;

async function createUser(email: string): Promise<string> {
  const [created] = await app.db.insert(users).values({ email }).returning();
  if (created === undefined) throw new Error('the fixture user was not created');
  return created.id;
}

beforeAll(async () => {
  postgres = await startTestPostgres();
  await runMigrations(postgres.connectionString);
  app = createApp({
    DATABASE_URL: postgres.connectionString,
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
    SESSION_SECRET,
    API_PUBLIC_URL,
    DASHBOARD_BASE_URL,
  });
  await app.ready();
  // Outside production the mailer records instead of sending, which is what
  // lets a test read the link the way a person reads their inbox.
  mailer = app.mailer as RecordingMailer;
  ownerId = await createUser(OWNER_EMAIL);
  strangerId = await createUser(STRANGER_EMAIL);
});

afterAll(async () => {
  try {
    await app.close();
  } finally {
    await postgres.stop();
  }
});

beforeEach(async () => {
  await app.db.delete(loginTokens);
  mailer.clear();
});

interface Refusal {
  readonly error: { readonly code: string; readonly message: string };
}

function code(body: string): string {
  return (JSON.parse(body) as Refusal).error.code;
}

async function requestLink(email: unknown): Promise<{ statusCode: number; body: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/request-link',
    payload: { email },
  });
  return { statusCode: response.statusCode, body: response.body };
}

/** The token out of the link the mailer was handed, as a browser would follow it. */
function tokenFrom(link: string): string {
  const token = new URL(link).searchParams.get('token');
  if (token === null) throw new Error(`the mailed link carried no token: ${link}`);
  return token;
}

async function issuedTokenFor(email: string): Promise<string> {
  const { statusCode } = await requestLink(email);
  expect(statusCode).toBe(202);
  const mail = mailer.last();
  if (mail === undefined) throw new Error(`no link was mailed to ${email}`);
  return tokenFrom(mail.link);
}

type Injected = Awaited<ReturnType<FastifyInstance['inject']>>;

function follow(token: string): Promise<Injected> {
  return app.inject({
    method: 'GET',
    url: `/auth/callback?token=${encodeURIComponent(token)}`,
  });
}

/** Every `Set-Cookie` on a response, whether Fastify sent one or several. */
function setCookies(response: Injected): string[] {
  const header = response.headers['set-cookie'];
  if (header === undefined) return [];
  return Array.isArray(header) ? header : [String(header)];
}

/**
 * The `Cookie` header a browser would send next, or `undefined` when the
 * response issued no session at all — which is what every refusal must do.
 */
function sessionCookie(response: Injected): string | undefined {
  const issued = setCookies(response).find((cookie) =>
    cookie.startsWith(`${SESSION_COOKIE_NAME}=`),
  );
  if (issued === undefined) return undefined;
  const value = issued.slice(SESSION_COOKIE_NAME.length + 1).split(';')[0] ?? '';
  return value === '' ? undefined : `${SESSION_COOKIE_NAME}=${value}`;
}

function whoAmI(cookie: string | undefined): Promise<Injected> {
  return app.inject({
    method: 'GET',
    url: '/auth/session',
    ...(cookie === undefined ? {} : { headers: { cookie } }),
  });
}

describe('POST /auth/request-link', () => {
  it('hands the mailer a single-use link for a seeded address', async () => {
    const before = Date.now();

    const response = await requestLink(OWNER_EMAIL);

    expect(response.statusCode).toBe(202);
    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.last();
    expect(mail?.to).toBe(OWNER_EMAIL);
    // The link points back at this server, carrying the token and nothing else
    // a recipient has to understand.
    expect(mail?.link.startsWith(`${API_PUBLIC_URL}/auth/callback?token=`)).toBe(true);
    expect(tokenFrom(mail?.link ?? '').length).toBeGreaterThan(20);
    // It expires, and within the quarter hour the module documents rather than
    // at some point in the far future.
    const lifetime = (mail?.expiresAt.getTime() ?? 0) - before;
    expect(lifetime).toBeGreaterThan(0);
    expect(lifetime).toBeLessThanOrEqual(15 * 60 * 1000 + 5_000);

    const [row] = await app.db.select().from(loginTokens);
    expect(row?.userId).toBe(ownerId);
    expect(row?.consumedAt).toBeNull();
  });

  it('stores a digest of the link and never the link itself', async () => {
    const token = await issuedTokenFor(OWNER_EMAIL);

    const rows = await app.db.select().from(loginTokens);

    // A database that leaked must not also be a database that can mint a
    // working link, so the token appears nowhere in the row that records it.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenDigest).toBe(digestLoginToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('answers an unknown address byte-identically to a known one', async () => {
    const known = await requestLink(OWNER_EMAIL);
    mailer.clear();
    await app.db.delete(loginTokens);

    const unknown = await requestLink(NOBODY_EMAIL);

    // Status and body both, because a body that differed by one word would
    // still be an oracle for "does this person have an account here".
    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.body).toBe(known.body);
    // And nothing happened behind the identical answer.
    expect(mailer.sent).toEqual([]);
    await expect(app.db.select().from(loginTokens)).resolves.toEqual([]);
  });

  it('answers a seeded address that has no email set the same way', async () => {
    // A user row can exist with no address at all; asking for a link by an
    // address must not match one of those, and must not say so either.
    const [chatOnly] = await app.db.insert(users).values({ telegramChatId: 'chat-only' }).returning();
    expect(chatOnly?.email).toBeNull();

    const response = await requestLink('');

    expect(response.statusCode).toBe(400);
    expect(code(response.body)).toBe('validation_failed');
    await expect(app.db.select().from(loginTokens)).resolves.toEqual([]);

    await app.db.delete(users).where(eq(users.id, chatOnly?.id ?? ''));
  });

  it('refuses a body it cannot read and issues nothing', async () => {
    for (const payload of [
      { email: 'not-an-address' },
      { email: 42 },
      {},
      { email: OWNER_EMAIL, redirectTo: 'https://evil.test' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/request-link',
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(code(response.body), JSON.stringify(payload)).toBe('validation_failed');
    }

    expect(mailer.sent).toEqual([]);
    await expect(app.db.select().from(loginTokens)).resolves.toEqual([]);
  });
});

describe('GET /auth/callback', () => {
  it('spends the link, issues an httpOnly session, and lands on the dashboard', async () => {
    const token = await issuedTokenFor(OWNER_EMAIL);

    const response = await follow(token);

    expect(response.statusCode).toBe(303);
    expect(response.headers['location']).toBe(`${DASHBOARD_BASE_URL}/`);

    const [issued] = setCookies(response);
    expect(issued).toBeDefined();
    // No script has any business reading this: an XSS bug must not also be an
    // account takeover.
    expect(issued).toContain('HttpOnly');
    expect(issued).toContain('SameSite=Lax');
    expect(issued).toContain('Path=/');
    expect(issued).toMatch(/Max-Age=\d+/u);
    // Loopback http in a test, so `Secure` would make the cookie undeliverable.
    expect(issued).not.toContain('Secure');

    const cookie = sessionCookie(response);
    const session = await whoAmI(cookie);
    expect(session.statusCode).toBe(200);
    expect(session.json()).toEqual({ id: ownerId, email: OWNER_EMAIL });

    const [row] = await app.db.select().from(loginTokens);
    expect(row?.consumedAt).toBeInstanceOf(Date);
  });

  it('refuses a second visit to a link that was already followed', async () => {
    const token = await issuedTokenFor(OWNER_EMAIL);
    const first = await follow(token);
    expect(sessionCookie(first)).toBeDefined();

    const second = await follow(token);

    expect(second.statusCode).toBe(303);
    expect(second.headers['location']).toBe(`${DASHBOARD_BASE_URL}/login?error=invalid_link`);
    expect(sessionCookie(second)).toBeUndefined();
  });

  it('refuses a link that has expired', async () => {
    // Inserted rather than waited for: the row is the only thing that decides,
    // and the alternative is a test that takes a quarter of an hour.
    const token = 'a-token-that-was-issued-a-while-ago';
    await app.db.insert(loginTokens).values({
      userId: ownerId,
      tokenDigest: digestLoginToken(token),
      expiresAt: new Date(Date.now() - 1_000),
    });

    const response = await follow(token);

    expect(response.statusCode).toBe(303);
    expect(response.headers['location']).toBe(`${DASHBOARD_BASE_URL}/login?error=invalid_link`);
    expect(sessionCookie(response)).toBeUndefined();
    // Expired, and left expired: nothing about the refusal spent the row.
    const [row] = await app.db.select().from(loginTokens);
    expect(row?.consumedAt).toBeNull();
  });

  it('refuses a token somebody edited, and leaves the real one usable', async () => {
    const token = await issuedTokenFor(OWNER_EMAIL);
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    expect(tampered).not.toBe(token);

    const response = await follow(tampered);

    expect(response.statusCode).toBe(303);
    expect(response.headers['location']).toBe(`${DASHBOARD_BASE_URL}/login?error=invalid_link`);
    expect(sessionCookie(response)).toBeUndefined();
    // Side-effect-free: the attempt did not spend the link it was guessing at.
    const accepted = await follow(token);
    expect(sessionCookie(accepted)).toBeDefined();
  });

  it('refuses a token that was never issued', async () => {
    const response = await follow('never-issued-at-all');

    expect(response.statusCode).toBe(303);
    expect(response.headers['location']).toBe(`${DASHBOARD_BASE_URL}/login?error=invalid_link`);
    expect(sessionCookie(response)).toBeUndefined();
  });

  it('refuses a visit carrying no token at all', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/callback' });

    expect(response.statusCode).toBe(400);
    expect(code(response.body)).toBe('validation_failed');
  });

  it('authenticates exactly one of two visits racing for the same link', async () => {
    const token = await issuedTokenFor(OWNER_EMAIL);

    // Fired together rather than one after the other: the point is the window
    // between checking a token and spending it, and a sequential pair never
    // opens one.
    const [left, right] = await Promise.all([follow(token), follow(token)]);

    const issued = [sessionCookie(left), sessionCookie(right)].filter(
      (cookie) => cookie !== undefined,
    );
    expect(issued).toHaveLength(1);
    // The one that won is a real session, and the row was spent exactly once.
    const session = await whoAmI(issued[0]);
    expect(session.statusCode).toBe(200);
    expect(session.json<{ id: string }>().id).toBe(ownerId);
    const rows = await app.db.select().from(loginTokens);
    expect(rows.filter((row) => row.consumedAt !== null)).toHaveLength(1);
  });

  it('mints a session for the address the link was issued to and nobody else', async () => {
    const strangerToken = await issuedTokenFor(STRANGER_EMAIL);

    const response = await follow(strangerToken);

    const session = await whoAmI(sessionCookie(response));
    expect(session.json()).toEqual({ id: strangerId, email: STRANGER_EMAIL });
  });
});

describe('the session cookie', () => {
  it('treats a cookie it cannot verify as unauthenticated, never as an error', async () => {
    const cookies = [
      // Garbage.
      `${SESSION_COOKIE_NAME}=nonsense`,
      // Shaped like a token, signed by nobody.
      `${SESSION_COOKIE_NAME}=eyJ1aWQiOiJ4In0.not-a-signature`,
      // Signed with a secret this server does not hold.
      `${SESSION_COOKIE_NAME}=${signSession(ownerId, 'some-other-secret', new Date(Date.now() + 60_000))}`,
      // A different cookie entirely.
      'unrelated=value',
    ];

    for (const cookie of cookies) {
      const response = await app.inject({ method: 'GET', url: '/watches', headers: { cookie } });

      expect(response.statusCode, cookie).toBe(401);
      expect(code(response.body), cookie).toBe('unauthorized');
    }
  });

  it('refuses a request that carries no cookie at all', async () => {
    const response = await app.inject({ method: 'GET', url: '/watches' });

    expect(response.statusCode).toBe(401);
    expect(code(response.body)).toBe('unauthorized');
  });

  it('refuses a session that has expired', async () => {
    const expired = mintSessionCookie(ownerId, SESSION_SECRET, -1_000);

    const response = await whoAmI(expired);

    expect(response.statusCode).toBe(401);
    expect(code(response.body)).toBe('unauthorized');
  });

  it('refuses a perfectly signed session for a user who is gone', async () => {
    // The cookie outlives the row, and the row is the authority.
    const cookie = mintSessionCookie(randomUUID(), SESSION_SECRET);

    const response = await whoAmI(cookie);

    expect(response.statusCode).toBe(401);
    expect(code(response.body)).toBe('unauthorized');
  });

  it('is the identity every other route reads, with no header able to override it', async () => {
    const cookie = mintSessionCookie(ownerId, SESSION_SECRET);

    const response = await app.inject({
      method: 'GET',
      url: '/watches',
      // The header this seam used to trust. It is not a fallback and not an
      // override: a caller naming a user id gets nowhere.
      headers: { cookie, 'x-user-id': strangerId },
    });

    expect(response.statusCode).toBe(200);
    const session = await whoAmI(cookie);
    expect(session.json<{ id: string }>().id).toBe(ownerId);

    const impersonation = await app.inject({
      method: 'GET',
      url: '/watches',
      headers: { 'x-user-id': ownerId },
    });
    expect(impersonation.statusCode).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  it('ends the session and sends the browser back to the request-link page', async () => {
    const token = await issuedTokenFor(OWNER_EMAIL);
    const cookie = sessionCookie(await follow(token));
    expect((await whoAmI(cookie)).statusCode).toBe(200);

    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      ...(cookie === undefined ? {} : { headers: { cookie } }),
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers['location']).toBe(`${DASHBOARD_BASE_URL}/login`);
    const [cleared] = setCookies(response);
    // Emptied as well as expired, so a client that ignores Max-Age is still
    // left holding nothing that verifies.
    expect(cleared).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(cleared).toContain('Max-Age=0');
    expect(sessionCookie(response)).toBeUndefined();

    // What the browser has after following that response authenticates nobody.
    const after = await whoAmI(`${SESSION_COOKIE_NAME}=`);
    expect(after.statusCode).toBe(401);
  });

  it('is willing to end a session that was never there', async () => {
    // A logout link on a page loaded before a restart should not answer 500.
    const response = await app.inject({ method: 'POST', url: '/auth/logout' });

    expect(response.statusCode).toBe(303);
    expect(response.headers['location']).toBe(`${DASHBOARD_BASE_URL}/login`);
  });
});
