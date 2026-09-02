import { describeOutcome, type FetchTier, type TierPolicy, type WatchRecord, type WatchStore } from '@chief-of-staff/core';
import { createDatabase, runMigrations, users, watches, type Database } from '@chief-of-staff/db';
import { startTestPostgres, type TestPostgres } from '@chief-of-staff/db/testing';
import {
  DEFAULT_ESCALATION_TOKEN,
  ESCALATION_HEADER,
  startFakestoreFixture,
  type FakestoreControl,
  type FixtureHandle,
} from '@chief-of-staff/fixtures';
import { createLocalProvider, type BrowserProvider } from '@chief-of-staff/solari';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDrizzleWatchStore } from '../store.js';
import { createFetchLadder, fetchWatchPage, type FetchLadder } from './ladder.js';

/**
 * The ladder end to end: the fixture shop in each of its hostile modes, a local
 * Chromium behind the provider seam, and a migrated database holding the tier
 * floor between checks. These are the tiered-fetching spec's proofs, made
 * against real pages rather than recorded ones.
 *
 * On stealth: the local provider applies none and says so. The tier-2 proof
 * asserts that echo as it is, which is the seam's contract - the fetch record
 * reports what the provider did, not what the ladder asked for.
 */

let postgres: TestPostgres;
let database: Database;
let userId: string;
let shop: FixtureHandle<FakestoreControl>;
let provider: BrowserProvider;
let ladder: FetchLadder;
/** The same tiers with nothing to show the hard-blocked gate. */
let unmarkedLadder: FetchLadder;

beforeAll(async () => {
  [postgres, shop] = await Promise.all([startTestPostgres(), startFakestoreFixture()]);
  await shop.control.setProduct('widget', { title: 'Widget', price: 19.99, stock: 'in_stock' });
  await runMigrations(postgres.connectionString);
  database = createDatabase(postgres.connectionString);
  const [user] = await database.db.insert(users).values({ telegramChatId: '4243' }).returning();
  if (user === undefined) throw new Error('expected the user row back');
  userId = user.id;

  provider = createLocalProvider();
  // Generous on purpose: a Chromium sharing a workstation with a Postgres
  // container and a sibling test run has been seen to take twenty seconds
  // over one navigation. A hang still fails; a slow machine does not.
  const shared = { provider, http: { timeoutMs: 10_000 }, browserTimeoutMs: 60_000 };
  ladder = createFetchLadder({ ...shared, escalationHeaders: { [ESCALATION_HEADER]: DEFAULT_ESCALATION_TOKEN } });
  unmarkedLadder = createFetchLadder(shared);
});

afterAll(async () => {
  await provider.dispose();
  await shop.stop();
  await database.close();
  await postgres.stop();
});

beforeEach(async () => {
  await shop.control.setMode('normal');
});

interface Placed {
  readonly tierPolicy?: TierPolicy;
  readonly tierFloor?: FetchTier;
  readonly path?: string;
}

async function placeWatch(store: WatchStore, placed: Placed = {}): Promise<WatchRecord> {
  const [row] = await database.db
    .insert(watches)
    .values({
      userId,
      kind: 'price',
      url: `${shop.url}${placed.path ?? '/product/widget'}`,
      extractor: {},
      condition: { drops_below: 15 },
      schedule: '*/15 * * * *',
      tierPolicy: placed.tierPolicy ?? 'auto',
      tierFloor: placed.tierFloor ?? 'http',
    })
    .returning();
  if (row === undefined) throw new Error('expected the watch row back');
  return reload(store, row.id);
}

async function reload(store: WatchStore, id: string): Promise<WatchRecord> {
  const watch = await store.loadWatch(id);
  if (watch === undefined) throw new Error(`watch ${id} vanished`);
  return watch;
}

describe('the fetch ladder against the fixture shop', () => {
  it('plain mode: served at tier 0, and the floor stays where it was', async () => {
    const store = createDrizzleWatchStore(database);
    const watch = await placeWatch(store);

    const { outcome, tierFloor } = await fetchWatchPage(ladder, store, watch);

    expect(outcome).toMatchObject({ kind: 'fetched', tier: 'http', meta: { status: 200, stealth: false } });
    expect(outcome.attempts.map((attempt) => attempt.tier)).toEqual(['http']);
    if (outcome.kind === 'fetched') expect(outcome.html).toContain('data-testid="product-price"');
    expect(tierFloor).toBe('http');
    expect((await reload(store, watch.id)).tierFloor).toBe('http');
  });

  it('blocked mode: refused at tier 0, served by the browser, and the floor rises and sticks', async () => {
    await shop.control.setMode('blocked');
    const store = createDrizzleWatchStore(database);
    const watch = await placeWatch(store);

    const first = await fetchWatchPage(ladder, store, watch);

    expect(first.outcome, describeOutcome(first.outcome)).toMatchObject({
      kind: 'fetched',
      tier: 'browser',
      meta: { status: 200, stealth: false },
    });
    const [refusal, served] = first.outcome.attempts;
    expect(refusal).toMatchObject({ ok: true, tier: 'http' });
    if (refusal?.ok === true) expect(refusal.html).toContain('data-testid="captcha-challenge"');
    expect(served).toMatchObject({ ok: true, tier: 'browser' });
    if (first.outcome.kind === 'fetched') {
      // The materialised page, not the shell: the script ran and rewrote the marker.
      expect(first.outcome.html).toContain('data-testid="product-price"');
      expect(first.outcome.html).toContain('fixture-state:normal');
      expect(first.outcome.html).not.toContain('data-testid="captcha-challenge"');
    }
    expect(first.tierFloor).toBe('browser');

    // Next check: the watch reads its raised floor and pays for no refusal.
    const learned = await reload(store, watch.id);
    expect(learned.tierFloor).toBe('browser');
    const second = await fetchWatchPage(ladder, store, learned);
    expect(second.outcome.attempts.map((attempt) => attempt.tier)).toEqual(['browser']);
    expect(second.outcome, describeOutcome(second.outcome)).toMatchObject({ kind: 'fetched', tier: 'browser' });
  });

  it('hard-blocked mode: only the escalation-marked tier is served, and the stealth echo is recorded as given', async () => {
    await shop.control.setMode('hard-blocked');
    const store = createDrizzleWatchStore(database);
    const watch = await placeWatch(store);

    const { outcome, tierFloor } = await fetchWatchPage(ladder, store, watch);

    expect(outcome.attempts.map((attempt) => attempt.tier)).toEqual(['http', 'browser', 'stealth']);
    // The local provider applies no stealth and says so; the record repeats it.
    expect(outcome).toMatchObject({ kind: 'fetched', tier: 'stealth', meta: { status: 200, stealth: false } });
    if (outcome.kind === 'fetched') expect(outcome.html).toContain('data-testid="product-price"');
    expect(tierFloor).toBe('stealth');
    expect((await reload(store, watch.id)).tierFloor).toBe('stealth');
  });

  it('an exhausted ladder yields the blocked verdict and learns nothing', async () => {
    await shop.control.setMode('hard-blocked');
    const store = createDrizzleWatchStore(database);
    const watch = await placeWatch(store);

    const { outcome, tierFloor } = await fetchWatchPage(unmarkedLadder, store, watch);

    expect(outcome).toEqual(
      expect.objectContaining({
        kind: 'blocked',
        tiersTried: ['http', 'browser', 'stealth'],
        signal: 'challenge-markers',
      }),
    );
    expect(outcome.attempts).toHaveLength(3);
    expect(tierFloor).toBe('http');
    expect((await reload(store, watch.id)).tierFloor).toBe('http');
  });

  it('a pinned tier is tried alone, and a vanished page is gone without escalating', async () => {
    const store = createDrizzleWatchStore(database);

    const pinned = await placeWatch(store, { tierPolicy: 'browser' });
    const viaBrowser = await fetchWatchPage(ladder, store, pinned);
    expect(viaBrowser.outcome.attempts.map((attempt) => attempt.tier)).toEqual(['browser']);
    expect(viaBrowser.outcome).toMatchObject({ kind: 'fetched', tier: 'browser' });

    await shop.control.setMode('blocked');
    const vanished = await placeWatch(store, { path: '/product/nothing-here' });
    const gone = await fetchWatchPage(ladder, store, vanished);
    expect(gone.outcome).toMatchObject({ kind: 'gone', tier: 'http' });
    expect(gone.outcome.attempts).toHaveLength(1);
  });
});
