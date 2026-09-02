import {
  checkSchedule,
  hasExtractor,
  parseCondition,
  parseExtractorSpec,
  tiersToTry,
  type WatchRecord,
} from '@chief-of-staff/core';
import { runMigrations, users, watches } from '@chief-of-staff/db';
import { startTestPostgres, type TestPostgres } from '@chief-of-staff/db/testing';
import { createDrizzleWatchStore } from '@chief-of-staff/watch';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { mintSessionCookie } from './auth/session.js';
import type { ErrorEnvelope } from './errors.js';

/**
 * The watch surface as the engine needs it: a configuration that comes
 * through the door is one a check can run, one that cannot is refused by
 * field with nothing written, and the learned tier floor can be reset by the
 * person who owns the watch. The rows are read back through the engine's own
 * store, so what is asserted is what a check will see, not what the API
 * echoed.
 */

const SESSION_SECRET = 'the-secret-this-suite-configured';

let postgres: TestPostgres;
let app: FastifyInstance;
let ownerId: string;
let strangerId: string;

async function createUser(telegramChatId: string): Promise<string> {
  const [created] = await app.db.insert(users).values({ telegramChatId }).returning();
  if (created === undefined) throw new Error('the fixture user was not created');
  return created.id;
}

beforeAll(async () => {
  postgres = await startTestPostgres();
  await runMigrations(postgres.connectionString);
  app = createApp({ DATABASE_URL: postgres.connectionString, LOG_LEVEL: 'silent', SESSION_SECRET });
  await app.ready();
  ownerId = await createUser('owner');
  strangerId = await createUser('stranger');
});

afterAll(async () => {
  try {
    await app.close();
  } finally {
    await postgres.stop();
  }
});

beforeEach(async () => {
  await app.db.delete(watches);
});

function asOwner(): Record<string, string> {
  return { cookie: mintSessionCookie(ownerId, SESSION_SECRET) };
}

function envelope(body: string): ErrorEnvelope['error'] {
  return (JSON.parse(body) as ErrorEnvelope).error;
}

function paths(body: string): string[] {
  return (envelope(body).details ?? []).map((detail) => detail.path).sort();
}

async function post(payload: unknown): Promise<{ statusCode: number; body: string; json: () => unknown }> {
  return app.inject({ method: 'POST', url: '/watches', headers: asOwner(), payload: payload as object });
}

async function loadAsEngine(id: string): Promise<WatchRecord> {
  const record = await createDrizzleWatchStore(app).loadWatch(id);
  if (record === undefined) throw new Error(`watch ${id} was not persisted`);
  return record;
}

const PRICE_WATCH = {
  kind: 'price',
  url: 'https://shop.test/product/widget',
  schedule: '*/15 * * * *',
  condition: { drops_below: 15 },
} as const;

const DIGEST_SPEC = { version: 1, strategy: 'css', selector: 'h1', attribute: null, parse: 'digest' } as const;

describe('POST /watches, as the engine reads it back', () => {
  it('persists a price watch the check path can run', async () => {
    const response = await post(PRICE_WATCH);

    expect(response.statusCode).toBe(201);
    const { id } = response.json() as { id: string };
    const record = await loadAsEngine(id);
    expect(parseCondition(record.kind, record.condition)).toEqual({ kind: 'price', drops_below: 15, rises_above: null });
    expect(tiersToTry(record.tierPolicy, record.tierFloor)).toEqual(['http', 'browser', 'stealth']);
    expect(checkSchedule(record.schedule)).toMatchObject({ ok: true, shortestGapMs: 900_000 });
    // No extractor yet: the model writes one on the first check.
    expect(hasExtractor(record.extractor)).toBe(false);
    expect(record).toMatchObject({ url: PRICE_WATCH.url, status: 'active', health: 'healthy', tierFloor: 'http' });
  });

  it('persists a change watch with its region, a pinned tier and a ready-made extractor', async () => {
    const response = await post({
      kind: 'change',
      url: 'https://news.test/story/1',
      schedule: '0 * * * *',
      condition: { region: 'the headline' },
      tierPolicy: 'browser',
      extractor: DIGEST_SPEC,
    });

    expect(response.statusCode).toBe(201);
    const { id } = response.json() as { id: string };
    const record = await loadAsEngine(id);
    expect(parseCondition(record.kind, record.condition)).toEqual({ kind: 'change', region: 'the headline' });
    expect(tiersToTry(record.tierPolicy, record.tierFloor)).toEqual(['browser']);
    expect(parseExtractorSpec(record.extractor)).toEqual(DIGEST_SPEC);
  });

  it('refuses everything the engine could not run at once, by field, and stores nothing', async () => {
    const response = await post({
      kind: 'price',
      url: 'https://user:hunter2@shop.test/product/widget',
      schedule: '*/2 * * * *',
      condition: { drops_below: 30, rises_above: 20, colour: 'red' },
      extractor: { selector: '.price' },
    });

    expect(response.statusCode).toBe(400);
    expect(envelope(response.body).code).toBe('validation_failed');
    expect(paths(response.body)).toEqual(['/condition', '/condition/colour', '/extractor', '/schedule', '/url']);
    // The refusal names the field, never the secret the field carried.
    expect(response.body).not.toContain('hunter2');
    await expect(app.db.select().from(watches)).resolves.toEqual([]);
  });

  it('refuses each price condition the comparator could not act on', async () => {
    const refused: [unknown, string][] = [
      [{}, '/condition'],
      [{ drops_below: 'cheap' }, '/condition/drops_below'],
      [{ drops_below: 0 }, '/condition/drops_below'],
      [{ rises_above: -1 }, '/condition/rises_above'],
      [{ drops_below: 20, rises_above: 20 }, '/condition'],
    ];
    for (const [condition, path] of refused) {
      const response = await post({ ...PRICE_WATCH, condition });
      expect(response.statusCode, JSON.stringify(condition)).toBe(400);
      expect(envelope(response.body).code).toBe('validation_failed');
      expect(paths(response.body), JSON.stringify(condition)).toEqual([path]);
    }
    await expect(app.db.select().from(watches)).resolves.toEqual([]);
  });

  it('refuses a change region that says nothing, and a price extractor on a change watch', async () => {
    const change = { kind: 'change', url: 'https://news.test/story/1', schedule: '0 * * * *' } as const;

    const blank = await post({ ...change, condition: { region: '   ' } });
    expect(blank.statusCode).toBe(400);
    expect(paths(blank.body)).toEqual(['/condition/region']);

    const wrongParser = await post({ ...change, condition: {}, extractor: { ...DIGEST_SPEC, parse: 'price' } });
    expect(wrongParser.statusCode).toBe(400);
    expect(paths(wrongParser.body)).toEqual(['/extractor/parse']);

    await expect(app.db.select().from(watches)).resolves.toEqual([]);
  });

  it('refuses a schedule under the five-minute floor', async () => {
    for (const schedule of ['* * * * *', '0,3 * * * *']) {
      const response = await post({ ...PRICE_WATCH, schedule });
      expect(response.statusCode, schedule).toBe(400);
      expect(paths(response.body), schedule).toEqual(['/schedule']);
    }
    await expect(app.db.select().from(watches)).resolves.toEqual([]);
  });

  it('refuses a slot watch until slot-sniping teaches the engine to check one', async () => {
    const response = await post({ ...PRICE_WATCH, kind: 'slot', condition: {} });

    expect(response.statusCode).toBe(400);
    expect(paths(response.body)).toEqual(['/kind']);
    await expect(app.db.select().from(watches)).resolves.toEqual([]);
  });
});

async function createBlockedWatchFor(userId: string): Promise<string> {
  const [created] = await app.db
    .insert(watches)
    .values({
      ...PRICE_WATCH,
      userId,
      extractor: {},
      tierFloor: 'stealth',
      health: 'blocked',
      lastError: 'blocked at every tier tried (http, browser, stealth): challenge-markers',
    })
    .returning();
  if (created === undefined) throw new Error('the fixture watch was not created');
  return created.id;
}

describe('POST /watches/:id/tier-reset', () => {
  it('clears the learned floor and the health the ladder set, and keeps the last check\'s story', async () => {
    const id = await createBlockedWatchFor(ownerId);

    const response = await app.inject({ method: 'POST', url: `/watches/${id}/tier-reset`, headers: asOwner() });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id, tierFloor: 'http', health: 'healthy' });
    const record = await loadAsEngine(id);
    expect(tiersToTry(record.tierPolicy, record.tierFloor)).toEqual(['http', 'browser', 'stealth']);
    expect(record.health).toBe('healthy');
    // What the last check found is still what the last check found.
    expect(record.lastError).toContain('blocked at every tier');
  });

  it('leaves another user\'s watch alone and answers as if it did not exist', async () => {
    const id = await createBlockedWatchFor(strangerId);

    const response = await app.inject({ method: 'POST', url: `/watches/${id}/tier-reset`, headers: asOwner() });

    expect(response.statusCode).toBe(404);
    expect(envelope(response.body).code).toBe('not_found');
    const record = await loadAsEngine(id);
    expect(record).toMatchObject({ tierFloor: 'stealth', health: 'blocked' });
  });

  it('refuses an id that is not a uuid', async () => {
    const response = await app.inject({ method: 'POST', url: '/watches/not-a-uuid/tier-reset', headers: asOwner() });

    expect(response.statusCode).toBe(400);
    expect(envelope(response.body).code).toBe('validation_failed');
  });
});
