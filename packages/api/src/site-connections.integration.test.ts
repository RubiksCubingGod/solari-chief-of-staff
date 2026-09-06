import { runMigrations, siteConnections, users } from '@chief-of-staff/db';
import { startTestPostgres, type TestPostgres } from '@chief-of-staff/db/testing';
import type { BrowserProfile, ProfileStore } from '@chief-of-staff/solari';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { mintSessionCookie } from './auth/session.js';

/**
 * The connect-site flow, from the route inwards: a scripted profile store where
 * the vendor would be, the real routes, the real ledger of open attempts and a
 * real database.
 *
 * The flow exists because the only way a person can log into a site for the
 * worker is the vendor console's profile editor. So the server's job is
 * bookkeeping around a thing it cannot watch: mint a profile, hand the person
 * the console link and the profile's name, and keep only the profile id once
 * they say they are done. Every case here is about that bookkeeping being
 * exact - a row exists precisely when the person confirmed, a vendor profile
 * exists precisely while a row or an open attempt needs it.
 */

const SESSION_SECRET = 'the-secret-this-suite-configured';
const DASHBOARD = 'https://dashboard.example.test';
const GYM = 'gym.example.test';

interface ScriptedStore extends ProfileStore {
  /** Every name asked for, in order. */
  readonly created: string[];
  /** Every id deleted, in order. */
  readonly deleted: string[];
  /** The profiles the vendor currently holds. */
  readonly held: () => string[];
  /** Makes the next create fail as the vendor would over its plan cap. */
  refuseCreates: (error: unknown) => void;
}

function scriptedStore(): ScriptedStore {
  const created: string[] = [];
  const deleted: string[] = [];
  const profiles = new Map<string, BrowserProfile>();
  let refusal: unknown;
  let minted = 0;
  return {
    created,
    deleted,
    held: () => [...profiles.keys()],
    refuseCreates: (error) => {
      refusal = error;
    },
    create: (name) => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the vendor SDK is not ours and can reject with anything
      if (refusal !== undefined) return Promise.reject(refusal);
      minted += 1;
      const profile = { id: `prof_${String(minted)}`, name };
      profiles.set(profile.id, profile);
      created.push(name);
      return Promise.resolve(profile);
    },
    delete: (id) => {
      deleted.push(id);
      profiles.delete(id);
      return Promise.resolve();
    },
    list: () => Promise.resolve([...profiles.values()]),
  };
}

let postgres: TestPostgres;
let app: FastifyInstance;
/** Fresh per test, so every case reads its own vendor from a clean ledger. */
let store: ScriptedStore;
/** What the one app mints against: whichever store the current test holds. */
const currentStore: ProfileStore = {
  create: (name) => store.create(name),
  delete: (id) => store.delete(id),
  list: () => store.list(),
};
let ownerId: string;
let strangerId: string;
const extraApps: FastifyInstance[] = [];

async function createUser(app: FastifyInstance, telegramChatId: string): Promise<string> {
  const [created] = await app.db.insert(users).values({ telegramChatId }).returning();
  if (created === undefined) throw new Error('the fixture user was not created');
  return created.id;
}

function appWith(options: {
  readonly profileStore?: ProfileStore;
  readonly connectTimeoutMs?: number;
  readonly environment?: Record<string, string>;
}): FastifyInstance {
  return createApp(
    {
      DATABASE_URL: postgres.connectionString,
      LOG_LEVEL: 'silent',
      SESSION_SECRET,
      DASHBOARD_BASE_URL: DASHBOARD,
      ...options.environment,
    },
    {
      ...(options.profileStore === undefined ? {} : { profileStore: options.profileStore }),
      ...(options.connectTimeoutMs === undefined
        ? {}
        : { connectTimeoutMs: options.connectTimeoutMs }),
    },
  );
}

beforeAll(async () => {
  postgres = await startTestPostgres();
  await runMigrations(postgres.connectionString);
  store = scriptedStore();
  app = appWith({ profileStore: currentStore });
  await app.ready();
  ownerId = await createUser(app, 'owner');
  strangerId = await createUser(app, 'stranger');
});

afterAll(async () => {
  try {
    await app.close();
  } finally {
    await postgres.stop();
  }
});

beforeEach(async () => {
  await app.db.delete(siteConnections);
  store = scriptedStore();
});

afterEach(async () => {
  for (const extra of extraApps.splice(0)) await extra.close();
});

function asUser(userId: string): Record<string, string> {
  return { cookie: mintSessionCookie(userId, SESSION_SECRET) };
}

function code(body: string): string {
  return (JSON.parse(body) as { error: { code: string } }).error.code;
}

interface Attempt {
  readonly id: string;
  readonly siteDomain: string;
  readonly status: string;
  readonly profileName: string;
  readonly editorUrl: string;
  readonly confirmUrl: string;
  readonly expiresAt: string;
}

async function start(userId = ownerId, siteDomain = GYM, on = app): Promise<Attempt> {
  const response = await on.inject({
    method: 'POST',
    url: '/site-connections/attempts',
    headers: asUser(userId),
    payload: { siteDomain },
  });
  expect(response.statusCode, 'POST /site-connections/attempts is not routed').toBe(201);
  return response.json<Attempt>();
}

async function read(id: string, userId = ownerId, on = app): Promise<{ status: number; body: Attempt }> {
  const response = await on.inject({
    method: 'GET',
    url: `/site-connections/attempts/${id}`,
    headers: asUser(userId),
  });
  return { status: response.statusCode, body: response.json<Attempt>() };
}

async function confirm(id: string, userId = ownerId, on = app) {
  return on.inject({
    method: 'POST',
    url: `/site-connections/attempts/${id}/confirm`,
    headers: asUser(userId),
  });
}

async function rows(userId: string) {
  return app.inject({ method: 'GET', url: '/site-connections', headers: asUser(userId) });
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('starting a connect attempt', () => {
  it('mints a vendor profile and hands back the console link, the name to look for, and where to confirm', async () => {
    const attempt = await start();

    expect(attempt.status).toBe('started');
    expect(attempt.siteDomain).toBe(GYM);
    // The person finds the profile in the console by its name, so the name has
    // to say which site it is for and be the one the vendor was actually given.
    expect(attempt.profileName).toContain(GYM);
    expect(store.created).toEqual([attempt.profileName]);
    // The vendor documents no API for a live-view or editor link; the console's
    // Profiles page is the documented door, and the flow says so plainly.
    expect(attempt.editorUrl).toBe('https://console.getsolari.com/profiles');
    expect(attempt.confirmUrl).toBe(`${DASHBOARD}/connect/${attempt.id}`);
    expect(Date.parse(attempt.expiresAt)).toBeGreaterThan(Date.now());
    // Started is not connected: nothing is written until the person says so.
    expect((await rows(ownerId)).json()).toEqual([]);
  });

  it('shows an open attempt to its owner and to nobody else', async () => {
    const attempt = await start();

    expect((await read(attempt.id)).body).toMatchObject({ id: attempt.id, status: 'started' });
    expect((await read(attempt.id, strangerId)).status).toBe(404);
  });

  it('refuses a domain that is not a bare host, by field, before touching the vendor', async () => {
    const before = store.created.length;
    for (const siteDomain of [`https://${GYM}/member`, 'not a domain', '', `${GYM}/member`, `user:pw@${GYM}`]) {
      const response = await app.inject({
        method: 'POST',
        url: '/site-connections/attempts',
        headers: asUser(ownerId),
        payload: { siteDomain },
      });
      expect(response.statusCode, siteDomain).toBe(400);
      expect(code(response.body)).toBe('validation_failed');
    }
    expect(store.created).toHaveLength(before);
  });

  it('answers 503 upstream_unavailable when the vendor refuses the profile, and keeps nothing', async () => {
    store.refuseCreates(new Error('PlanLimitExceeded: the plan allows 3 profiles'));

    const response = await app.inject({
      method: 'POST',
      url: '/site-connections/attempts',
      headers: asUser(ownerId),
      payload: { siteDomain: GYM },
    });

    expect(response.statusCode).toBe(503);
    expect(code(response.body)).toBe('upstream_unavailable');
    expect(response.body).toContain('PlanLimitExceeded');
  });

  it('quotes a refusal the vendor threw as something other than an Error, since it is still the reason', async () => {
    store.refuseCreates('PlanLimitExceeded: the plan allows 3 profiles');

    const response = await app.inject({
      method: 'POST',
      url: '/site-connections/attempts',
      headers: asUser(ownerId),
      payload: { siteDomain: GYM },
    });

    expect(response.statusCode).toBe(503);
    expect(code(response.body)).toBe('upstream_unavailable');
    expect(response.body).toContain('PlanLimitExceeded: the plan allows 3 profiles');
  });

  it('answers 503 upstream_unavailable when no vendor key is configured at all', async () => {
    const unconfigured = appWith({ environment: { SOLARI_API_KEY: '' } });
    extraApps.push(unconfigured);
    await unconfigured.ready();

    const response = await unconfigured.inject({
      method: 'POST',
      url: '/site-connections/attempts',
      headers: asUser(ownerId),
      payload: { siteDomain: GYM },
    });

    // Configuration, not a crash: the sentence names the variable an operator
    // has to set, and the dashboard can say the feature is not switched on.
    expect(response.statusCode).toBe(503);
    expect(code(response.body)).toBe('upstream_unavailable');
    expect(response.body).toContain('SOLARI_API_KEY');
  });

  it('is behind the session like every other route', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/site-connections/attempts',
      payload: { siteDomain: GYM },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('confirming', () => {
  it('keeps only the profile id, as a connected row the person can now list', async () => {
    const attempt = await start();

    const response = await confirm(attempt.id);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ siteDomain: GYM, status: 'connected', lastUsedAt: null });
    const [row] = await app.db.select().from(siteConnections);
    expect(row).toMatchObject({ userId: ownerId, siteDomain: GYM, solariProfileId: 'prof_1', status: 'connected' });
    // The id is what the worker attaches; nothing about the account is here.
    expect((await rows(ownerId)).json()).toEqual([
      expect.objectContaining({ siteDomain: GYM, status: 'connected' }),
    ]);
    expect((await rows(ownerId)).body).not.toContain('prof_1');
    expect((await read(attempt.id)).body.status).toBe('confirmed');
    expect(store.held()).toEqual(['prof_1']);
  });

  it('confirms once: a second confirm finds no open attempt', async () => {
    const attempt = await start();
    await confirm(attempt.id);

    const again = await confirm(attempt.id);

    expect(again.statusCode).toBe(404);
    expect(await app.db.select().from(siteConnections)).toHaveLength(1);
  });

  it('re-links a site by updating the row and retiring the profile it replaced', async () => {
    const first = await start();
    await confirm(first.id);
    const [before] = await app.db.select().from(siteConnections);

    const second = await start();
    const response = await confirm(second.id);

    expect(response.statusCode).toBe(200);
    const all = await app.db.select().from(siteConnections);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: before?.id, solariProfileId: 'prof_2', status: 'connected' });
    // One reusable profile per site per user, at the vendor as in the database.
    expect(store.deleted).toContain('prof_1');
    expect(store.held()).toEqual(['prof_2']);
  });

  it('is refused for somebody else\'s attempt, as one that does not exist', async () => {
    const attempt = await start();

    expect((await confirm(attempt.id, strangerId)).statusCode).toBe(404);
    expect(await app.db.select().from(siteConnections)).toEqual([]);
  });
});

describe('abandoning', () => {
  it('has nothing to cancel for an attempt nobody opened', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/site-connections/attempts/nobody-opened-this',
      headers: asUser(ownerId),
    });

    expect(response.statusCode).toBe(404);
    expect(code(response.body)).toBe('not_found');
  });

  it('cancels on request: the profile goes, no row appears, the attempt says cancelled', async () => {
    const attempt = await start();

    const response = await app.inject({
      method: 'DELETE',
      url: `/site-connections/attempts/${attempt.id}`,
      headers: asUser(ownerId),
    });

    expect(response.statusCode).toBe(204);
    expect(store.held()).toEqual([]);
    expect(await app.db.select().from(siteConnections)).toEqual([]);
    expect((await read(attempt.id)).body.status).toBe('cancelled');
    expect((await confirm(attempt.id)).statusCode).toBe(404);
  });

  it('times out an attempt nobody confirmed, leaving no half-connected row and no orphan profile', async () => {
    const quick = appWith({ profileStore: store, connectTimeoutMs: 100 });
    extraApps.push(quick);
    await quick.ready();
    const attempt = await start(ownerId, GYM, quick);
    expect(Date.parse(attempt.expiresAt) - Date.now()).toBeLessThanOrEqual(100);

    await wait(300);

    expect((await read(attempt.id, ownerId, quick)).body.status).toBe('expired');
    expect(store.held()).toEqual([]);
    expect(await app.db.select().from(siteConnections)).toEqual([]);
    // Too late to confirm: the profile the person logged into is gone, and a
    // row pointing at it would be the half-connected state this exists to avoid.
    expect((await confirm(attempt.id, ownerId, quick)).statusCode).toBe(404);
  });

  it('cleans up an attempt still open when the server stops', async () => {
    const stopping = appWith({ profileStore: store });
    await stopping.ready();
    await start(ownerId, GYM, stopping);
    const [open] = store.held();
    expect(open).toBeDefined();

    await stopping.close();

    // A restart must not leak a profile per attempt that was open at the time.
    expect(store.deleted).toContain(open);
    expect(store.held()).toEqual([]);
  });
});

describe('an existing connection', () => {
  async function connected(userId = ownerId): Promise<string> {
    const attempt = await start(userId);
    const response = await confirm(attempt.id, userId);
    return response.json<{ id: string }>().id;
  }

  it('flips to expired on request, and the list says so', async () => {
    const id = await connected();

    const response = await app.inject({
      method: 'PATCH',
      url: `/site-connections/${id}`,
      headers: asUser(ownerId),
      payload: { status: 'expired' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id, status: 'expired' });
    expect((await rows(ownerId)).json()).toEqual([expect.objectContaining({ id, status: 'expired' })]);
  });

  it('only ever flips one way through this door: connected is what confirming means', async () => {
    const id = await connected();

    const response = await app.inject({
      method: 'PATCH',
      url: `/site-connections/${id}`,
      headers: asUser(ownerId),
      payload: { status: 'connected' },
    });

    expect(response.statusCode).toBe(400);
    expect(code(response.body)).toBe('validation_failed');
  });

  it('is somebody else\'s to a stranger, which is to say nobody\'s', async () => {
    const id = await connected();

    const response = await app.inject({
      method: 'PATCH',
      url: `/site-connections/${id}`,
      headers: asUser(strangerId),
      payload: { status: 'expired' },
    });

    expect(response.statusCode).toBe(404);
    expect((await rows(strangerId)).json()).toEqual([]);
  });
});
