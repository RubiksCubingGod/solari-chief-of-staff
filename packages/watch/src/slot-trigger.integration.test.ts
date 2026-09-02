import { randomUUID } from 'node:crypto';

import type { ExtractorCreator, ExtractorRequest } from '@chief-of-staff/agent';
import {
  BOOK_SLOT_TASK_KIND,
  EXTRACTOR_SPEC_VERSION,
  createRecordingNotifier,
  describeReplayFailure,
  parseBookSlotInput,
  parserForKind,
  replayExtractor,
  triggerDedupKey,
  type ExtractorSpec,
  type RecordingNotifier,
  type SlotCondition,
  type SlotsValue,
  type WatchRecord,
} from '@chief-of-staff/core';
import {
  TASK_RUN_QUEUE,
  createDatabase,
  createJobHarness,
  observations,
  runMigrations,
  runWorker,
  tasks,
  users,
  watches,
  type Database,
  type JobHarness,
} from '@chief-of-staff/db';
import { startTestPostgres, type TestPostgres } from '@chief-of-staff/db/testing';
import { startFakedmvFixture, type FakedmvControl, type FixtureHandle } from '@chief-of-staff/fixtures';
import { createLocalProvider, type BrowserProvider } from '@chief-of-staff/solari';
import { asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { checkWatch, registerWatchEngine, type CheckReport, type WatchCheckPorts } from './check.js';
import { createFetchLadder, type FetchLadder } from './fetch/ladder.js';
import { WATCH_CHECK_QUEUE } from './scheduler.js';
import {
  createDrizzleSlotTrigger,
  rearmWatch,
  type SlotTriggerPort,
} from './slot-trigger.js';
import { createDrizzleWatchStore } from './store.js';

/**
 * The slot half of the slot-snipe-path spec, up to the task: a slot watch on
 * fakedmv, checked through the real ladder, store and trigger port over a
 * migrated Postgres. What is proved is the reflex's first move - a released
 * slot becomes one observation, one queued booking task and one paused watch,
 * committed together - and the two ways it must not fire twice: a re-run check
 * while the task is pending, and two checks racing for the same slot. The
 * booking arm and the re-arm consequences are the other two tasks' proofs.
 */

let postgres: TestPostgres;
let database: Database;
let userId: string;
let dmv: FixtureHandle<FakedmvControl>;
let provider: BrowserProvider;
let ladder: FetchLadder;
let store: ReturnType<typeof createDrizzleWatchStore>;
let trigger: SlotTriggerPort;
const started: JobHarness[] = [];

const SLOT_SELECTOR = '.dmv-slot .dmv-when';

const SLOT_SPEC: ExtractorSpec = {
  version: EXTRACTOR_SPEC_VERSION,
  strategy: 'css',
  selector: SLOT_SELECTOR,
  attribute: null,
  parse: 'slots',
};

const CONDITION: SlotCondition = {
  kind: 'slot',
  site: 'fakedmv',
  applicant: { name: 'Ada Lovelace' },
  auto_book: false,
};

const TUESDAY = { id: 'tue-0900', startsAt: '2026-09-08T09:00:00Z', label: 'Tue 8 Sep, 09:00' };
const THURSDAY = { id: 'thu-1400', startsAt: '2026-09-10T14:00:00Z', label: 'Thu 10 Sep, 14:00' };

const NO_SLOTS: SlotsValue = { kind: 'slots', slots: [] };
const TUESDAY_LISTED: SlotsValue = { kind: 'slots', slots: [{ id: TUESDAY.label, label: TUESDAY.label }] };

/** A cron that will not fire during a test: ticks here are enqueued by hand. */
const QUIET_CRON = '0 0 1 1 *';

beforeAll(async () => {
  [postgres, dmv] = await Promise.all([startTestPostgres(), startFakedmvFixture()]);
  await runMigrations(postgres.connectionString);
  database = createDatabase(postgres.connectionString);
  store = createDrizzleWatchStore(database);
  trigger = createDrizzleSlotTrigger(database);
  const [user] = await database.db.insert(users).values({ telegramChatId: '4245' }).returning();
  if (user === undefined) throw new Error('expected the user row back');
  userId = user.id;
  provider = createLocalProvider();
  ladder = createFetchLadder({ provider, http: { timeoutMs: 10_000 } });
  await dmv.control.seed({ slots: [] });
});

beforeEach(async () => {
  await dmv.control.reset();
});

afterEach(async () => {
  for (const harness of started.splice(0)) await harness.stop();
  await database.db.delete(tasks);
  await database.db.delete(watches);
});

afterAll(async () => {
  await provider.dispose();
  await dmv.stop();
  await database.close();
  await postgres.stop();
});

/** A creator with the model's judgement written down: each answer is a selector, replayed as the real creator does. */
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
          return Promise.resolve({ ok: false, failure: 'no-proposal', reason: 'the model described the page' });
        }
        const parse = parserForKind(request.kind);
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
      kind: 'slot',
      url: `${dmv.url}/appointments`,
      extractor: SLOT_SPEC,
      condition: { site: 'fakedmv', applicant: { name: 'Ada Lovelace' } },
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

async function tasksOf(): Promise<(typeof tasks.$inferSelect)[]> {
  return database.db.select().from(tasks).orderBy(asc(tasks.createdAt));
}

interface Bench {
  readonly ports: WatchCheckPorts;
  readonly notifier: RecordingNotifier;
  readonly requests: ExtractorRequest[];
}

function bench(...selectors: readonly string[]): Bench {
  const { creator, requests } = proposing(...selectors);
  const notifier = createRecordingNotifier();
  return { ports: { store, ladder, creator, notifier, slotTrigger: trigger }, notifier, requests };
}

function observed(report: CheckReport): Extract<CheckReport, { kind: 'observed' }> {
  if (report.kind !== 'observed') throw new Error(`expected an observation, got a failure: ${report.reason}`);
  return report;
}

function failed(report: CheckReport): Extract<CheckReport, { kind: 'failed' }> {
  if (report.kind !== 'failed') throw new Error(`expected a failure, got an observation: ${report.comparison.reason}`);
  return report;
}

/** The engine as the worker runs it, on a harness of its own; the trigger port is the engine's own. */
async function bootEngine(ports: Pick<WatchCheckPorts, 'creator' | 'notifier'>): Promise<JobHarness> {
  const harness = createJobHarness({
    connectionString: postgres.connectionString,
    schema: `pgboss_${randomUUID().slice(0, 8)}`,
    pollingIntervalSeconds: 0.5,
    cronIntervalSeconds: 1,
  });
  started.push(harness);
  await runWorker(harness, [
    registerWatchEngine({ db: database, ladder, creator: ports.creator, notifier: ports.notifier }),
  ]);
  return harness;
}

async function tick(harness: JobHarness, watchId: string): Promise<void> {
  const jobId = await harness.enqueue(WATCH_CHECK_QUEUE, { watchId });
  await vi.waitFor(
    async () => {
      expect((await harness.inspect(WATCH_CHECK_QUEUE, jobId))?.state).toBe('completed');
    },
    { timeout: 30_000, interval: 100 },
  );
}

describe('a slot watch on fakedmv', () => {
  it('reads an empty calendar as no slots, and a released slot as one observation, one queued task and one paused watch', async () => {
    const { ports, notifier } = bench();
    const watch = await insertWatch();

    const empty = observed(await checkWatch(ports, watch));

    expect(empty.comparison).toEqual({ triggered: false, reason: 'no slots available' });
    expect(empty.observation).toMatchObject({ tierUsed: 'http', value: NO_SLOTS, triggered: false, error: null });
    expect(await reload(watch.id)).toMatchObject({ status: 'active', lastValue: NO_SLOTS, health: 'healthy' });
    expect(await tasksOf()).toEqual([]);
    expect(notifier.calls).toEqual([]);

    await dmv.control.publishSlot(TUESDAY);
    const release = observed(await checkWatch(ports, await reload(watch.id)));

    expect(release.comparison).toEqual({
      triggered: true,
      reason: `slot ${TUESDAY.label} appeared`,
      slot: { id: TUESDAY.label, label: TUESDAY.label },
    });
    expect(release.snipe).toMatchObject({ armed: true, taskId: expect.any(String) as string });
    expect(release.observation).toMatchObject({ value: TUESDAY_LISTED, triggered: true, error: null });

    const paused = await reload(watch.id);
    expect(paused).toMatchObject({ status: 'paused', lastValue: TUESDAY_LISTED, consecutiveFailures: 0, lastError: null });

    const [task, ...rest] = await tasksOf();
    expect(rest).toEqual([]);
    expect(task).toMatchObject({ userId, kind: BOOK_SLOT_TASK_KIND, mode: 'playbook', status: 'queued' });
    expect(parseBookSlotInput(task?.input)).toEqual({
      site: 'fakedmv',
      watchId: watch.id,
      url: watch.url,
      slot: { id: TUESDAY.label, label: TUESDAY.label },
      applicant: { name: 'Ada Lovelace' },
      auto_book: false,
    });

    expect(notifier.events).toEqual([
      {
        type: 'triggered',
        watchId: watch.id,
        userId,
        url: watch.url,
        occurredAt: expect.any(String) as string,
        dedupKey: triggerDedupKey(watch.id, CONDITION, TUESDAY_LISTED),
        kind: 'slot',
        condition: CONDITION,
        previous: NO_SLOTS,
        current: TUESDAY_LISTED,
        reason: `slot ${TUESDAY.label} appeared`,
      },
    ]);

    // The fixture has not been touched: detection books nothing.
    expect(await dmv.control.bookings()).toEqual([]);
    expect((await dmv.control.slots()).map((slot) => slot.status)).toEqual(['open']);
  });

  it('enqueues nothing on a re-run check while the task is pending, and nothing through the worker for a paused watch', async () => {
    const { ports, notifier } = bench();
    const watch = await insertWatch({ lastValue: NO_SLOTS });
    await dmv.control.publishSlot(TUESDAY);

    const first = observed(await checkWatch(ports, watch));
    expect(first.snipe).toMatchObject({ armed: true });

    // A check re-run by hand on the row as it was - the delivery a crashed
    // worker's retry would make - finds the watch already armed.
    const rerun = observed(await checkWatch(ports, watch));
    expect(rerun.comparison.triggered).toBe(true);
    expect(rerun.snipe).toMatchObject({ armed: false, reason: expect.stringContaining('already paused') as string });
    expect(rerun.observation).toMatchObject({ value: TUESDAY_LISTED, triggered: false });

    // And the scheduler's tick on the paused row does not even fetch.
    const harness = await bootEngine(ports);
    await tick(harness, watch.id);

    expect(await tasksOf()).toHaveLength(1);
    expect(await reload(watch.id)).toMatchObject({ status: 'paused', lastValue: TUESDAY_LISTED });
    expect((await observationsOf(watch.id)).map((row) => row.triggered)).toEqual([true, false]);
    // Told once: a sighting that armed nothing is not news.
    expect(notifier.calls).toHaveLength(1);
    expect(notifier.events).toHaveLength(1);
  });

  it('arms once when two checks race for the same slot', async () => {
    const { ports } = bench();
    const watch = await insertWatch({ lastValue: NO_SLOTS });
    await dmv.control.publishSlot(TUESDAY);

    const [left, right] = await Promise.all([checkWatch(ports, watch), checkWatch(ports, watch)]);

    const armed = [observed(left).snipe, observed(right).snipe].filter((snipe) => snipe?.armed === true);
    expect(armed).toHaveLength(1);
    expect(await tasksOf()).toHaveLength(1);
    expect(await reload(watch.id)).toMatchObject({ status: 'paused' });
    expect(await observationsOf(watch.id)).toHaveLength(2);
  });

  it('rolls the pause back when the observation cannot be written, so the pause and the trigger commit together', async () => {
    const watch = await insertWatch({ lastValue: NO_SLOTS });
    const slot = { id: TUESDAY.label, label: TUESDAY.label };

    await expect(
      trigger.arm({
        watch,
        condition: CONDITION,
        slot,
        // A tier the schema has no value for: the observation insert fails after the pause.
        observation: { tierUsed: 'warp' as 'http', value: TUESDAY_LISTED, triggered: true, error: null },
        patch: { lastValue: TUESDAY_LISTED },
      }),
    ).rejects.toThrow(/insert into "observations"/u);

    expect(await reload(watch.id)).toMatchObject({ status: 'active', lastValue: NO_SLOTS });
    expect(await tasksOf()).toEqual([]);
    expect(await observationsOf(watch.id)).toEqual([]);
  });

  it('through the worker: the first tick writes the extractor and the release enqueues the run on the task queue', async () => {
    const { ports, requests } = bench(SLOT_SELECTOR);
    const watch = await insertWatch({ extractor: {} });
    const harness = await bootEngine(ports);

    await tick(harness, watch.id);
    expect(await reload(watch.id)).toMatchObject({ extractor: SLOT_SPEC, health: 'healthy', lastValue: NO_SLOTS, status: 'active' });
    expect(requests).toEqual([{ url: watch.url, kind: 'slot', html: expect.any(String) as string, hint: null }]);

    await dmv.control.publishSlot(TUESDAY);
    await tick(harness, watch.id);

    const [task] = await tasksOf();
    expect(task).toMatchObject({ kind: BOOK_SLOT_TASK_KIND, status: 'queued', jobId: expect.any(String) as string });
    expect(await reload(watch.id)).toMatchObject({ status: 'paused' });
    // The run is on the queue the task engine reads, waiting for a worker that has one.
    expect((await harness.inspect(TASK_RUN_QUEUE, task?.jobId ?? ''))?.state).toBe('created');
  });

  it('re-arms into an active watch that triggers nothing until a fresh check extracts a slot again', async () => {
    const { ports, notifier } = bench();
    const watch = await insertWatch({ lastValue: NO_SLOTS });
    await dmv.control.publishSlot(TUESDAY);
    const release = observed(await checkWatch(ports, watch));
    expect(release.snipe).toMatchObject({ armed: true });

    // The slot is yanked; the booking arm reports it gone and the watch is re-armed.
    await dmv.control.withdrawSlot(TUESDAY.id);
    expect(await rearmWatch(database, watch.id, { clearBaseline: true })).toBe(true);

    const rearmed = await reload(watch.id);
    expect(rearmed).toMatchObject({ status: 'active', lastValue: null });
    expect(await tasksOf()).toHaveLength(1);
    expect(notifier.events).toHaveLength(1);

    // A fresh check finds the calendar empty: no stale trigger from the old observation.
    const fresh = observed(await checkWatch(ports, rearmed));
    expect(fresh.comparison).toEqual({ triggered: false, reason: 'no slots available' });
    expect(fresh.snipe).toBeUndefined();
    expect(await tasksOf()).toHaveLength(1);
    expect(await reload(watch.id)).toMatchObject({ status: 'active', lastValue: NO_SLOTS });

    // Re-released, the same slot is new again and books again.
    await dmv.control.publishSlot(TUESDAY);
    const again = observed(await checkWatch(ports, await reload(watch.id)));
    expect(again.snipe).toMatchObject({ armed: true });
    expect(await tasksOf()).toHaveLength(2);
    expect(await reload(watch.id)).toMatchObject({ status: 'paused' });
    // Told again, under the same key: the sighting is the same slot on the
    // same watch, and it is the booking's own outcome that will carry the news.
    expect(notifier.calls).toHaveLength(2);
    expect(notifier.events).toHaveLength(1);

    // A decline keeps the baseline, so the declined slot is not offered again.
    expect(await rearmWatch(database, watch.id, { clearBaseline: false })).toBe(true);
    const kept = observed(await checkWatch(ports, await reload(watch.id)));
    expect(kept.comparison).toEqual({ triggered: false, reason: 'no slot that was not listed last time' });
    expect(await tasksOf()).toHaveLength(2);

    // A second slot beside it is news.
    await dmv.control.publishSlot(THURSDAY);
    const second = observed(await checkWatch(ports, await reload(watch.id)));
    expect(second.comparison.slot).toEqual({ id: THURSDAY.label, label: THURSDAY.label });
    expect(await tasksOf()).toHaveLength(3);
  });

  it('fails a slot watch, without moving its baseline, on a worker that has no trigger port', async () => {
    const { ports, notifier } = bench();
    const watch = await insertWatch({ lastValue: NO_SLOTS });
    await dmv.control.publishSlot(TUESDAY);
    const bare: WatchCheckPorts = { store: ports.store, ladder: ports.ladder, creator: ports.creator, notifier };

    const report = failed(await checkWatch(bare, watch));

    expect(report).toMatchObject({ transient: false, reason: expect.stringContaining('no booking trigger') as string });
    expect(await reload(watch.id)).toMatchObject({ status: 'active', lastValue: NO_SLOTS, consecutiveFailures: 1 });
    expect(await tasksOf()).toEqual([]);
    // Nobody is told about a slot nothing will act on; the row says why.
    expect(notifier.events).toHaveLength(0);
  });
});
