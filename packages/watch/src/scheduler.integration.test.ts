import { randomUUID } from 'node:crypto';

import type { WatchRecord } from '@chief-of-staff/core';
import {
  createDatabase,
  createJobHarness,
  runMigrations,
  runWorker,
  users,
  watches,
  type Database,
  type JobHarness,
} from '@chief-of-staff/db';
import { startTestPostgres, type TestPostgres } from '@chief-of-staff/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  WATCH_CHECK_QUEUE,
  WATCH_RECONCILE_CRON,
  WATCH_RECONCILE_QUEUE,
  reconcileWatchSchedules,
  registerWatchScheduler,
  runWatchCheckJob,
  type WatchCheck,
} from './scheduler.js';
import { createDrizzleWatchStore } from './store.js';

/**
 * The scheduler on a real harness and a migrated database. What is proved is
 * the watch-check-path spec's scheduling half: an active watch ticks on its
 * own cron, a paused one stops, a deleted one is deregistered, and a tick that
 * was already in the queue survives the worker that was going to run it.
 *
 * The `watches` table is the source of truth. The scheduler never hears from
 * the API; it reads the rows and makes the harness match, once at startup and
 * once a minute after that, and the tick handler reads the row again before
 * it does anything, so a pause is honoured at the next tick whether or not
 * the reconcile has run yet.
 */

let postgres: TestPostgres;
let database: Database;
let userId: string;
const started: JobHarness[] = [];

beforeAll(async () => {
  postgres = await startTestPostgres();
  await runMigrations(postgres.connectionString);
  database = createDatabase(postgres.connectionString);
  const [user] = await database.db.insert(users).values({ telegramChatId: '4242' }).returning();
  if (user === undefined) throw new Error('expected the user row back');
  userId = user.id;
});

afterEach(async () => {
  for (const harness of started.splice(0)) await harness.stop();
  // Reconcile reads every watch there is, so one test's rows must not become
  // the next test's schedules.
  await database.db.delete(watches);
});

afterAll(async () => {
  await database.close();
  await postgres.stop();
});

/**
 * Its own pg-boss schema per harness, so the schedules one test registered
 * are not on the queue when the next test counts them. A restart test passes
 * the schema on, because the queued job lives there.
 */
function harness(schema = `pgboss_${randomUUID().slice(0, 8)}`): JobHarness {
  const instance = createJobHarness({
    connectionString: postgres.connectionString,
    schema,
    pollingIntervalSeconds: 0.5,
    cronIntervalSeconds: 1,
  });
  started.push(instance);
  return instance;
}

async function insertWatch(overrides: Partial<typeof watches.$inferInsert> = {}): Promise<string> {
  const [row] = await database.db
    .insert(watches)
    .values({
      userId,
      kind: 'price',
      url: 'https://shop.test/product/widget',
      extractor: {},
      condition: { drops_below: 15 },
      schedule: '*/15 * * * *',
      ...overrides,
    })
    .returning();
  if (row === undefined) throw new Error('expected the watch row back');
  return row.id;
}

async function loadRow(id: string): Promise<typeof watches.$inferSelect | undefined> {
  const [row] = await database.db.select().from(watches).where(eq(watches.id, id)).limit(1);
  return row;
}

/** A check double: it remembers every watch it was handed and does nothing else. */
function recorder(): { readonly check: WatchCheck; readonly seen: WatchRecord[] } {
  const seen: WatchRecord[] = [];
  return {
    seen,
    check: (watch) => {
      seen.push(watch);
      return Promise.resolve();
    },
  };
}

async function bootScheduler(check: WatchCheck, schema?: string): Promise<JobHarness> {
  const instance = harness(schema);
  await runWorker(instance, [registerWatchScheduler({ db: database, check })]);
  return instance;
}

async function waitForCompletion(instance: JobHarness, queue: string, jobId: string): Promise<void> {
  await vi.waitFor(
    async () => {
      expect((await instance.inspect(queue, jobId))?.state).toBe('completed');
    },
    { timeout: 20_000, interval: 100 },
  );
}

describe('the watch scheduler', () => {
  it('registers one schedule per active watch, keyed by the watch, and none for a paused one', async () => {
    const active = await insertWatch({ schedule: '*/15 * * * *' });
    await insertWatch({ status: 'paused' });

    const instance = await bootScheduler(recorder().check);

    expect(await instance.schedules(WATCH_CHECK_QUEUE)).toEqual([
      { queue: WATCH_CHECK_QUEUE, key: active, cron: '*/15 * * * *', payload: { watchId: active } },
    ]);
    // The sweep that keeps the queue matching the table is itself scheduled.
    expect(await instance.schedules(WATCH_RECONCILE_QUEUE)).toMatchObject([
      { key: '', cron: WATCH_RECONCILE_CRON },
    ]);
  });

  it(
    'ticks an active watch on its own cron and hands the check the row as it is now',
    async () => {
      const id = await insertWatch({ schedule: '* * * * *' });
      const { check, seen } = recorder();

      await bootScheduler(check);

      await vi.waitFor(
        () => {
          expect(seen.length).toBeGreaterThan(0);
        },
        { timeout: 110_000, interval: 500 },
      );
      expect(seen[0]).toMatchObject({ id, status: 'active', schedule: '* * * * *', kind: 'price' });
    },
    120_000,
  );

  it('stops a paused watch: its schedule goes, and a tick already queued is turned away', async () => {
    const id = await insertWatch({ schedule: '*/5 * * * *' });
    const { check, seen } = recorder();
    const instance = await bootScheduler(check);
    expect(await instance.schedules(WATCH_CHECK_QUEUE)).toHaveLength(1);

    await database.db.update(watches).set({ status: 'paused' }).where(eq(watches.id, id));
    const report = await reconcileWatchSchedules(database, instance);

    expect(report).toEqual({ scheduled: [], kept: [], unscheduled: [id], refused: [] });
    expect(await instance.schedules(WATCH_CHECK_QUEUE)).toEqual([]);

    // A tick the cron had already put on the queue before the pause.
    const jobId = await instance.enqueue(WATCH_CHECK_QUEUE, { watchId: id });
    await waitForCompletion(instance, WATCH_CHECK_QUEUE, jobId);
    expect(seen).toEqual([]);
  });

  it('puts a resumed watch back on the schedule its row has now, and follows a later edit', async () => {
    const id = await insertWatch({ status: 'paused', schedule: '*/5 * * * *' });
    const instance = await bootScheduler(recorder().check);
    expect(await instance.schedules(WATCH_CHECK_QUEUE)).toEqual([]);

    await database.db
      .update(watches)
      .set({ status: 'active', schedule: '*/10 * * * *' })
      .where(eq(watches.id, id));
    expect(await reconcileWatchSchedules(database, instance)).toEqual({
      scheduled: [id],
      kept: [],
      unscheduled: [],
      refused: [],
    });
    expect(await instance.schedules(WATCH_CHECK_QUEUE)).toMatchObject([{ key: id, cron: '*/10 * * * *' }]);

    // Nothing changed: nothing is rewritten.
    expect(await reconcileWatchSchedules(database, instance)).toEqual({
      scheduled: [],
      kept: [id],
      unscheduled: [],
      refused: [],
    });

    await database.db.update(watches).set({ schedule: '*/20 * * * *' }).where(eq(watches.id, id));
    expect((await reconcileWatchSchedules(database, instance)).scheduled).toEqual([id]);
    expect(await instance.schedules(WATCH_CHECK_QUEUE)).toMatchObject([{ key: id, cron: '*/20 * * * *' }]);
  });

  it('deregisters a deleted watch and turns away the tick it left behind', async () => {
    const id = await insertWatch();
    const { check, seen } = recorder();
    const instance = await bootScheduler(check);
    expect(await instance.schedules(WATCH_CHECK_QUEUE)).toHaveLength(1);

    await database.db.delete(watches).where(eq(watches.id, id));
    const report = await reconcileWatchSchedules(database, instance);

    expect(report.unscheduled).toEqual([id]);
    expect(await instance.schedules(WATCH_CHECK_QUEUE)).toEqual([]);

    const jobId = await instance.enqueue(WATCH_CHECK_QUEUE, { watchId: id });
    await waitForCompletion(instance, WATCH_CHECK_QUEUE, jobId);
    expect(seen).toEqual([]);
  });

  it('runs a tick that was queued before the worker restarted', async () => {
    const id = await insertWatch();
    const schema = `pgboss_${randomUUID().slice(0, 8)}`;
    const first = harness(schema);
    await first.start();
    const jobId = await first.enqueue(WATCH_CHECK_QUEUE, { watchId: id });
    await first.stop();
    started.splice(started.indexOf(first), 1);

    const { check, seen } = recorder();
    const second = await bootScheduler(check, schema);

    await waitForCompletion(second, WATCH_CHECK_QUEUE, jobId);
    expect(seen.map((watch) => watch.id)).toEqual([id]);
  });

  it('refuses a schedule the harness cannot run, and says so on the row instead of silently skipping it', async () => {
    const id = await insertWatch({ schedule: 'every full moon' });
    const instance = await bootScheduler(recorder().check);

    const report = await reconcileWatchSchedules(database, instance);

    expect(report.refused).toEqual([{ watchId: id, reason: expect.any(String) as string }]);
    expect(report.scheduled).toEqual([]);
    expect(await instance.schedules(WATCH_CHECK_QUEUE)).toEqual([]);
    expect((await loadRow(id))?.lastError).toContain('every full moon');
  });
});

describe('the check job shell', () => {
  it('hands an active watch to the check', async () => {
    const id = await insertWatch();
    const { check, seen } = recorder();

    const outcome = await runWatchCheckJob(createDrizzleWatchStore(database), check, { watchId: id });

    expect(outcome).toEqual({ kind: 'checked' });
    expect(seen.map((watch) => watch.id)).toEqual([id]);
  });

  it('turns away a watch that is paused', async () => {
    const id = await insertWatch({ status: 'paused' });
    const { check, seen } = recorder();

    const outcome = await runWatchCheckJob(createDrizzleWatchStore(database), check, { watchId: id });

    expect(outcome).toEqual({ kind: 'skipped', reason: 'paused' });
    expect(seen).toEqual([]);
  });

  it('turns away a watch that no longer exists', async () => {
    const { check, seen } = recorder();

    const outcome = await runWatchCheckJob(createDrizzleWatchStore(database), check, {
      watchId: randomUUID(),
    });

    expect(outcome).toEqual({ kind: 'skipped', reason: 'gone' });
    expect(seen).toEqual([]);
  });
});
