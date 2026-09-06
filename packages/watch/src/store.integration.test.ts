import { errorObservation, successObservation, type WatchValue } from '@chief-of-staff/core';
import { createDatabase, runMigrations, users, watches, type Database } from '@chief-of-staff/db';
import { startTestPostgres, type TestPostgres } from '@chief-of-staff/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDrizzleWatchStore } from './store.js';

/**
 * The store port bound to Drizzle on a migrated database. What is proved is
 * the round trip the tiered-fetching spec calls sticky: a tier floor written
 * after one check is what the next check reads.
 */

let postgres: TestPostgres;
let database: Database;
let userId: string;

const PRICE: WatchValue = { kind: 'price', amount: 19.99, currency: 'USD', raw: '$19.99' };

beforeAll(async () => {
  postgres = await startTestPostgres();
  await runMigrations(postgres.connectionString);
  database = createDatabase(postgres.connectionString);
  const [user] = await database.db.insert(users).values({ telegramChatId: '4242' }).returning();
  if (user === undefined) throw new Error('expected the user row back');
  userId = user.id;
});

afterAll(async () => {
  await database.close();
  await postgres.stop();
});

async function createWatch(): Promise<string> {
  const [row] = await database.db
    .insert(watches)
    .values({
      userId,
      kind: 'price',
      url: 'https://shop.test/product/widget',
      extractor: {},
      condition: { drops_below: 15 },
      schedule: '*/15 * * * *',
    })
    .returning();
  if (row === undefined) throw new Error('expected the watch row back');
  return row.id;
}

describe('the Drizzle watch store', () => {
  it('loads a watch as the engine sees it, starting at the bottom of the ladder', async () => {
    const store = createDrizzleWatchStore(database);
    const id = await createWatch();

    const watch = await store.loadWatch(id);

    expect(watch).toMatchObject({
      id,
      userId,
      kind: 'price',
      url: 'https://shop.test/product/widget',
      extractor: {},
      condition: { drops_below: 15 },
      schedule: '*/15 * * * *',
      tierPolicy: 'auto',
      status: 'active',
      health: 'healthy',
      tierFloor: 'http',
      lastValue: null,
      lastCheckedAt: null,
      lastError: null,
      consecutiveFailures: 0,
    });
  });

  it('answers undefined for a watch that does not exist', async () => {
    const store = createDrizzleWatchStore(database);

    expect(await store.loadWatch('00000000-0000-4000-8000-000000000000')).toBeUndefined();
  });

  it('round-trips the tier floor and health a check leaves behind', async () => {
    const store = createDrizzleWatchStore(database);
    const id = await createWatch();

    await store.updateWatch(id, { tierFloor: 'browser', health: 'blocked', lastError: 'blocked at http' });

    expect(await store.loadWatch(id)).toMatchObject({
      tierFloor: 'browser',
      health: 'blocked',
      lastError: 'blocked at http',
    });
  });

  it('writes only the columns a patch names', async () => {
    const store = createDrizzleWatchStore(database);
    const id = await createWatch();
    await store.updateWatch(id, { tierFloor: 'stealth' });

    await store.updateWatch(id, { consecutiveFailures: 2 });
    await store.updateWatch(id, {});

    expect(await store.loadWatch(id)).toMatchObject({ tierFloor: 'stealth', consecutiveFailures: 2 });
  });

  it('records observations and reads the latest one back, value and all', async () => {
    const store = createDrizzleWatchStore(database);
    const id = await createWatch();
    expect(await store.lastObservation(id)).toBeUndefined();

    const first = await store.recordObservation(id, errorObservation('http', 'timeout: no response within 15000ms'));
    const second = await store.recordObservation(id, successObservation('browser', PRICE, true));

    expect(first).toMatchObject({
      watchId: id,
      tierUsed: 'http',
      value: null,
      triggered: false,
      error: 'timeout: no response within 15000ms',
    });
    expect(first.checkedAt).toBeInstanceOf(Date);
    expect(second).toMatchObject({ tierUsed: 'browser', value: PRICE, triggered: true, error: null });
    expect(await store.lastObservation(id)).toEqual(second);
  });

  it('stores an extractor and a last value as the jsonb they are', async () => {
    const store = createDrizzleWatchStore(database);
    const id = await createWatch();
    const extractor = { version: 1, strategy: 'css', selector: '.price', attribute: null, parse: 'price' };

    await store.updateWatch(id, { extractor, lastValue: PRICE, lastCheckedAt: new Date('2026-09-02T10:00:00Z') });

    expect(await store.loadWatch(id)).toMatchObject({
      extractor,
      lastValue: PRICE,
      lastCheckedAt: new Date('2026-09-02T10:00:00Z'),
    });
  });
});
