import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ExtractorCreator, ExtractorRequest } from '@chief-of-staff/agent';
import {
  EXTRACTOR_SPEC_VERSION,
  createRecordingNotifier,
  describeReplayFailure,
  parserForKind,
  replayExtractor,
  triggerDedupKey,
  type ExtractorSpec,
  type PriceCondition,
  type RecordingNotifier,
  type WatchRecord,
  type WatchValue,
} from '@chief-of-staff/core';
import {
  createDatabase,
  createJobHarness,
  observations,
  runMigrations,
  runWorker,
  users,
  watches,
  type Database,
  type JobHarness,
} from '@chief-of-staff/db';
import { startTestPostgres, type TestPostgres } from '@chief-of-staff/db/testing';
import {
  startFakenewsFixture,
  startFakestoreFixture,
  type FakenewsControl,
  type FakestoreControl,
  type FixtureHandle,
} from '@chief-of-staff/fixtures';
import { createLocalProvider, type BrowserProvider } from '@chief-of-staff/solari';
import { asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { blockedDedupKey, checkWatch, registerWatchEngine, type CheckReport, type WatchCheckPorts } from './check.js';
import { createFetchLadder, type FetchLadder } from './fetch/ladder.js';
import { WATCH_CHECK_QUEUE } from './scheduler.js';
import { createDrizzleWatchStore } from './store.js';

/**
 * The watch-check-path spec, end to end: booted fixtures, a migrated
 * Testcontainers Postgres, the real ladder, store and scheduler, and the
 * extract step over a creator whose judgement is scripted at the port. The
 * price path runs through the worker - ticks on the check queue, the way the
 * cron delivers them - so what is proved is the composition a deployment
 * runs, not a re-assembly of its parts.
 *
 * Every fixture stays in a mode the plain HTTP tier is served in, except the
 * one test about being refused, which pins the watch to that tier. The climb
 * through the browser tiers is the ladder's own proof.
 */

let postgres: TestPostgres;
let database: Database;
let userId: string;
let shop: FixtureHandle<FakestoreControl>;
let news: FixtureHandle<FakenewsControl>;
let provider: BrowserProvider;
let ladder: FetchLadder;
let store: ReturnType<typeof createDrizzleWatchStore>;
const started: JobHarness[] = [];

const PRICE_SELECTOR = '[data-testid="product-price"]';
const BODY_SELECTOR = '[data-testid="article-body"]';

const PRICE_SPEC: ExtractorSpec = {
  version: EXTRACTOR_SPEC_VERSION,
  strategy: 'css',
  selector: PRICE_SELECTOR,
  attribute: null,
  parse: 'price',
};

const CONDITION: PriceCondition = { kind: 'price', drops_below: 15, rises_above: null };

const FULL_PRICE: WatchValue = { kind: 'price', amount: 19.99, currency: 'USD', raw: '$19.99' };
const SALE_PRICE: WatchValue = { kind: 'price', amount: 14.99, currency: 'USD', raw: '$14.99' };

const WIDGET = { title: 'Widget', stock: 'in_stock' } as const;
const STORY = { headline: 'Council approves the bridge', body: 'The vote was 7 to 2.\n\nWork begins in spring.' };

/** A cron that will not fire during a test: ticks here are enqueued by hand. */
const QUIET_CRON = '0 0 1 1 *';

beforeAll(async () => {
  [postgres, shop, news] = await Promise.all([startTestPostgres(), startFakestoreFixture(), startFakenewsFixture()]);
  await runMigrations(postgres.connectionString);
  database = createDatabase(postgres.connectionString);
  store = createDrizzleWatchStore(database);
  const [user] = await database.db.insert(users).values({ telegramChatId: '4244' }).returning();
  if (user === undefined) throw new Error('expected the user row back');
  userId = user.id;

  provider = createLocalProvider();
  ladder = createFetchLadder({ provider, http: { timeoutMs: 10_000 } });
});

beforeEach(async () => {
  await Promise.all([shop.control.setMode('normal'), news.control.setMode('normal')]);
  await Promise.all([
    shop.control.setProduct('widget', { ...WIDGET, price: 19.99 }),
    news.control.setArticle('story', STORY),
  ]);
});

afterEach(async () => {
  for (const harness of started.splice(0)) await harness.stop();
  await database.db.delete(watches);
});

afterAll(async () => {
  await provider.dispose();
  await Promise.all([shop.stop(), news.stop()]);
  await database.close();
  await postgres.stop();
});

/**
 * A creator with the model's judgement written down: each answer is a
 * selector, turned into a spec and replayed against the page it was asked
 * about, as the real creator does with a proposal. Asked more often than it
 * has answers, it declines the way a model that only described the page does.
 */
function proposing(...selectors: readonly string[]): {
  readonly creator: ExtractorCreator;
  readonly requests: ExtractorRequest[];
} {
  const remaining = [...selectors];
  const requests: ExtractorRequest[] = [];
  return {
    requests,
    creator: {
      create(request) {
        requests.push(request);
        const selector = remaining.shift();
        if (selector === undefined) {
          return Promise.resolve({
            ok: false,
            failure: 'no-proposal',
            reason: 'the model described the page instead of choosing a selector',
          });
        }
        const parse = parserForKind(request.kind);
        if (parse === undefined) throw new Error(`no parser for ${request.kind} watches`);
        const spec: ExtractorSpec = { version: EXTRACTOR_SPEC_VERSION, strategy: 'css', selector, attribute: null, parse };
        const replay = replayExtractor(spec, request.html);
        return Promise.resolve(
          replay.ok
            ? { ok: true, spec, value: replay.value, rationale: null }
            : { ok: false, failure: 'replay-failed', reason: `${selector} did not replay: ${describeReplayFailure(replay)}` },
        );
      },
    },
  };
}

async function insertWatch(overrides: Partial<typeof watches.$inferInsert> = {}): Promise<WatchRecord> {
  const [row] = await database.db
    .insert(watches)
    .values({
      userId,
      kind: 'price',
      url: `${shop.url}/product/widget`,
      extractor: {},
      condition: { drops_below: 15 },
      schedule: QUIET_CRON,
      ...overrides,
    })
    .returning();
  if (row === undefined) throw new Error('expected the watch row back');
  return reload(row.id);
}

async function reload(id: string): Promise<WatchRecord> {
  const watch = await store.loadWatch(id);
  if (watch === undefined) throw new Error(`watch ${id} vanished`);
  return watch;
}

async function observationsOf(watchId: string): Promise<(typeof observations.$inferSelect)[]> {
  return database.db
    .select()
    .from(observations)
    .where(eq(observations.watchId, watchId))
    .orderBy(asc(observations.checkedAt), asc(observations.id));
}

interface Bench {
  readonly ports: WatchCheckPorts;
  readonly notifier: RecordingNotifier;
  readonly requests: ExtractorRequest[];
}

function bench(...selectors: readonly string[]): Bench {
  const { creator, requests } = proposing(...selectors);
  const notifier = createRecordingNotifier();
  return { ports: { store, ladder, creator, notifier }, notifier, requests };
}

type HarnessOptions = Parameters<typeof createJobHarness>[0];

/** The worker as a deployment runs it: the engine registered on a harness of its own. */
async function bootEngine(
  ports: Pick<WatchCheckPorts, 'creator' | 'notifier'>,
  options: Partial<HarnessOptions> = {},
): Promise<JobHarness> {
  const harness = createJobHarness({
    connectionString: postgres.connectionString,
    schema: `pgboss_${randomUUID().slice(0, 8)}`,
    pollingIntervalSeconds: 0.5,
    cronIntervalSeconds: 1,
    ...options,
  });
  started.push(harness);
  await runWorker(harness, [
    registerWatchEngine({ db: database, ladder, creator: ports.creator, notifier: ports.notifier }),
  ]);
  return harness;
}

async function settled(harness: JobHarness, jobId: string, state: 'completed' | 'failed'): Promise<void> {
  await vi.waitFor(
    async () => {
      expect((await harness.inspect(WATCH_CHECK_QUEUE, jobId))?.state).toBe(state);
    },
    { timeout: 30_000, interval: 100 },
  );
}

/** One tick, as the cron would deliver it, run to completion. */
async function tick(harness: JobHarness, watchId: string): Promise<void> {
  await settled(harness, await harness.enqueue(WATCH_CHECK_QUEUE, { watchId }), 'completed');
}

/** A loopback origin nobody listens on: taken, then released before the check. */
async function deadOrigin(): Promise<string> {
  const placeholder = createServer();
  const url = await new Promise<string>((resolve) => {
    placeholder.listen(0, '127.0.0.1', () => {
      const { port } = placeholder.address() as AddressInfo;
      resolve(`http://127.0.0.1:${String(port)}`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    placeholder.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return url;
}

function observed(report: CheckReport): Extract<CheckReport, { kind: 'observed' }> {
  if (report.kind !== 'observed') throw new Error(`expected an observation, got a failure: ${report.reason}`);
  return report;
}

function failed(report: CheckReport): Extract<CheckReport, { kind: 'failed' }> {
  if (report.kind !== 'failed') throw new Error(`expected a failure, got an observation: ${report.comparison.reason}`);
  return report;
}

describe('the check pipeline against the fixtures', () => {
  it('price path through the worker: the first tick writes the extractor, the crossing triggers once, the repeat does not, and a pause stops the ticks', async () => {
    const { ports, notifier, requests } = bench(PRICE_SELECTOR);
    const watch = await insertWatch();
    const harness = await bootEngine(ports);
    // The scheduler is composed in: the row is on the queue under its own cron.
    expect(await harness.schedules(WATCH_CHECK_QUEUE)).toMatchObject([{ key: watch.id, cron: QUIET_CRON }]);

    await tick(harness, watch.id);

    expect(await observationsOf(watch.id)).toMatchObject([
      { tierUsed: 'http', value: FULL_PRICE, triggered: false, error: null },
    ]);
    expect(await reload(watch.id)).toMatchObject({
      extractor: PRICE_SPEC,
      health: 'healthy',
      lastValue: FULL_PRICE,
      lastCheckedAt: expect.any(Date) as Date,
      lastError: null,
      consecutiveFailures: 0,
    });
    expect(requests).toEqual([{ url: watch.url, kind: 'price', html: expect.any(String) as string, hint: null }]);
    expect(notifier.calls).toEqual([]);

    await shop.control.setProduct('widget', { ...WIDGET, price: 14.99 });
    await tick(harness, watch.id);

    expect(notifier.events).toEqual([
      {
        type: 'triggered',
        watchId: watch.id,
        userId,
        url: watch.url,
        occurredAt: expect.any(String) as string,
        dedupKey: triggerDedupKey(watch.id, CONDITION, SALE_PRICE),
        kind: 'price',
        condition: CONDITION,
        previous: FULL_PRICE,
        current: SALE_PRICE,
        reason: 'price 14.99 drops below 15',
      },
    ]);

    // The same price again: the person was told last time.
    await tick(harness, watch.id);

    expect(notifier.calls).toHaveLength(1);
    expect((await observationsOf(watch.id)).map((row) => [row.value, row.triggered])).toEqual([
      [FULL_PRICE, false],
      [SALE_PRICE, true],
      [SALE_PRICE, false],
    ]);
    expect(await reload(watch.id)).toMatchObject({ lastValue: SALE_PRICE, consecutiveFailures: 0, lastError: null });
    // The model was asked once, for the extractor; every check after that replayed it.
    expect(requests).toHaveLength(1);

    await database.db.update(watches).set({ status: 'paused' }).where(eq(watches.id, watch.id));
    await tick(harness, watch.id);

    expect(await observationsOf(watch.id)).toHaveLength(3);
    expect(notifier.calls).toHaveLength(1);
  });

  it('change path: the first reading is the baseline, a changed article triggers, an unchanged one does not', async () => {
    const { ports, notifier, requests } = bench(BODY_SELECTOR);
    const watch = await insertWatch({
      kind: 'change',
      url: `${news.url}/article/story`,
      condition: { region: 'the article body' },
    });

    const first = observed(await checkWatch(ports, watch));

    expect(first).toMatchObject({ route: 'created', comparison: { triggered: false, reason: 'baseline recorded' } });
    expect(first.observation.value).toMatchObject({ kind: 'digest', excerpt: expect.stringContaining('The vote was 7 to 2.') as string });
    expect(requests[0]?.hint).toBe('the article body');
    expect(notifier.calls).toEqual([]);

    await news.control.setArticle('story', {
      ...STORY,
      body: `${STORY.body}\n\nUpdate: the contractor has been named.`,
    });
    const second = observed(await checkWatch(ports, await reload(watch.id)));

    expect(second).toMatchObject({ route: 'replayed', comparison: { triggered: true, reason: 'content changed' } });
    expect(second.observation.value).toMatchObject({ kind: 'digest', excerpt: expect.stringContaining('Update: the contractor') as string });
    expect(notifier.events).toMatchObject([
      {
        type: 'triggered',
        watchId: watch.id,
        userId,
        url: watch.url,
        kind: 'change',
        condition: { kind: 'change', region: 'the article body' },
        previous: first.observation.value,
        current: second.observation.value,
        reason: 'content changed',
      },
    ]);

    const third = observed(await checkWatch(ports, await reload(watch.id)));

    expect(third.comparison).toEqual({ triggered: false, reason: 'content unchanged' });
    expect(notifier.calls).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect((await observationsOf(watch.id)).map((row) => row.triggered)).toEqual([false, true, false]);
  });

  it('a site that is down: the observation carries the error, the last value stands, nothing triggers, and the worker retries the tick per its policy', async () => {
    const { ports, notifier } = bench();
    const watch = await insertWatch({
      url: `${await deadOrigin()}/product/widget`,
      extractor: PRICE_SPEC,
      lastValue: FULL_PRICE,
    });

    const report = failed(await checkWatch(ports, watch));

    expect(report.transient).toBe(true);
    expect(report.reason).toMatch(/^fetch failed at the http tier: network: .*ECONNREFUSED/u);
    expect(report.observation).toMatchObject({ tierUsed: 'http', value: null, triggered: false, error: report.reason });
    expect(await reload(watch.id)).toMatchObject({
      lastError: report.reason,
      consecutiveFailures: 1,
      lastValue: FULL_PRICE,
      health: 'healthy',
    });
    expect(notifier.calls).toEqual([]);

    // Through the worker, the same failure fails the tick, and the harness's
    // policy tries again before giving up: one observation per run. The
    // record counts retries, so a limit of one reads as one after two runs.
    const harness = await bootEngine(ports, { retryPolicy: { retryLimit: 1, retryDelaySeconds: 0 } });
    const jobId = await harness.enqueue(WATCH_CHECK_QUEUE, { watchId: watch.id });
    await settled(harness, jobId, 'failed');

    expect(await harness.inspect(WATCH_CHECK_QUEUE, jobId)).toMatchObject({ state: 'failed', attempts: 1 });
    expect(await observationsOf(watch.id)).toHaveLength(3);
    expect((await reload(watch.id)).consecutiveFailures).toBe(3);
    expect(notifier.calls).toEqual([]);
  });

  it('blocked at every tier the watch may try: health blocked, one event, and healthy again when the page is served', async () => {
    await shop.control.setMode('blocked');
    const { ports, notifier } = bench();
    const watch = await insertWatch({ tierPolicy: 'http', extractor: PRICE_SPEC });

    const first = failed(await checkWatch(ports, watch));

    expect(first).toMatchObject({ transient: false, reason: 'blocked at every tier tried (http): challenge-markers' });
    expect(first.observation).toMatchObject({ tierUsed: 'http', value: null, triggered: false, error: first.reason });
    expect(await reload(watch.id)).toMatchObject({ health: 'blocked', lastError: first.reason, consecutiveFailures: 1 });
    expect(notifier.events).toEqual([
      {
        type: 'blocked',
        watchId: watch.id,
        userId,
        url: watch.url,
        occurredAt: expect.any(String) as string,
        dedupKey: blockedDedupKey(watch.id, ['http'], 'challenge-markers'),
        tiersTried: ['http'],
        reason: first.reason,
      },
    ]);

    // Still blocked is not news.
    const second = failed(await checkWatch(ports, await reload(watch.id)));

    expect(second.reason).toBe(first.reason);
    expect((await reload(watch.id)).consecutiveFailures).toBe(2);
    expect(notifier.calls).toHaveLength(1);

    await shop.control.setMode('normal');
    const third = observed(await checkWatch(ports, await reload(watch.id)));

    expect(third).toMatchObject({ route: 'replayed', comparison: { triggered: false } });
    expect(await reload(watch.id)).toMatchObject({ health: 'healthy', lastError: null, consecutiveFailures: 0, lastValue: FULL_PRICE });
    expect(notifier.calls).toHaveLength(1);
  });

  it('a trigger whose delivery failed is delivered by the retry, once', async () => {
    const { ports, notifier } = bench();
    const watch = await insertWatch({ extractor: PRICE_SPEC, lastValue: FULL_PRICE });
    await shop.control.setProduct('widget', { ...WIDGET, price: 14.99 });
    notifier.failNextWith(new Error('the bot is down'));

    await expect(checkWatch(ports, watch)).rejects.toThrow('the bot is down');

    // Nothing was written, so the retry sees the same crossing.
    expect(await observationsOf(watch.id)).toEqual([]);
    expect(await reload(watch.id)).toMatchObject({ lastValue: FULL_PRICE, consecutiveFailures: 0 });

    const retry = observed(await checkWatch(ports, await reload(watch.id)));

    expect(retry.comparison).toEqual({ triggered: true, reason: 'price 14.99 drops below 15' });
    expect(notifier.events).toHaveLength(1);
    expect(notifier.events[0]?.dedupKey).toBe(triggerDedupKey(watch.id, CONDITION, SALE_PRICE));
    expect((await observationsOf(watch.id)).map((row) => row.triggered)).toEqual([true]);
  });

  it('a page that is gone, a condition nobody can read, and a model that will not write an extractor all land in state without an event', async () => {
    const { ports, notifier, requests } = bench();

    const gone = await insertWatch({ url: `${shop.url}/product/nothing-here`, extractor: PRICE_SPEC });
    const goneReport = failed(await checkWatch(ports, gone));
    expect(goneReport).toMatchObject({ transient: false, reason: 'the page is gone (404 or 410)' });
    expect(goneReport.observation).toMatchObject({ tierUsed: 'http', value: null, error: goneReport.reason });
    expect(await reload(gone.id)).toMatchObject({ lastError: goneReport.reason, consecutiveFailures: 1 });

    // A row that reached the table without going through the API's door.
    const odd = await insertWatch({ extractor: PRICE_SPEC, condition: { drops_below: 'cheap' } });
    const oddReport = failed(await checkWatch(ports, odd));
    expect(oddReport.transient).toBe(false);
    expect(oddReport.reason).toContain('condition');
    expect(oddReport.reason).toContain('cheap');
    expect(oddReport.observation).toMatchObject({ tierUsed: 'http', value: null, error: oddReport.reason });
    expect(await reload(odd.id)).toMatchObject({ lastError: oddReport.reason, consecutiveFailures: 1 });

    // No extractor, and a model that describes the page instead of choosing.
    const bare = await insertWatch();
    const bareReport = failed(await checkWatch(ports, bare));
    expect(bareReport).toMatchObject({ transient: false, reason: expect.stringContaining('no-proposal') as string });
    expect(await reload(bare.id)).toMatchObject({
      extractor: {},
      health: 'needs_extractor',
      lastError: bareReport.reason,
      consecutiveFailures: 1,
    });
    const again = failed(await checkWatch(ports, await reload(bare.id)));
    expect(again.reason).toContain('reset the watch');
    expect(requests).toHaveLength(1);

    expect(notifier.calls).toEqual([]);
  });
});
