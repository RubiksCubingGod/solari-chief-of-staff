import type { WatchRecord, WatchStore } from '@chief-of-staff/core';
import { watches, type Database, type JobHarness, type JobRegistration } from '@chief-of-staff/db';
import { eq } from 'drizzle-orm';

import { createDrizzleWatchStore } from './store.js';

/**
 * How a watch gets its ticks.
 *
 * The `watches` table is the source of truth and the scheduler never hears
 * from the API. It reads the rows and makes the harness match - one keyed
 * schedule per active watch on the check queue, none for a paused or deleted
 * one - once when the worker starts and once a minute after that. Against a
 * five-minute floor on every schedule, a minute is as long as a pause or a
 * resume takes to reach the queue, and it is the same reconciliation whether
 * the row changed through the API, through chat, or by hand.
 *
 * What the reconcile cannot catch is a tick the cron had already queued when
 * the pause landed, so the tick handler reads the row again before it does
 * anything. A paused watch never runs a check, whichever of the two noticed
 * the pause first.
 */

export const WATCH_CHECK_QUEUE = 'watch-check';
export const WATCH_RECONCILE_QUEUE = 'watch-check.reconcile';
export const WATCH_RECONCILE_CRON = '* * * * *';

/** The payload of a tick: the cron's, or one enqueued by hand for a check now. */
export interface WatchCheckJob {
  readonly watchId: string;
}

/**
 * The check behind a tick, with the row as it stood when the tick was taken.
 * The pipeline that fetches, extracts and compares plugs in here; the
 * scheduler knows only that it exists.
 */
export type WatchCheck = (watch: WatchRecord) => Promise<void>;

export type TickOutcome =
  | { readonly kind: 'checked' }
  | { readonly kind: 'skipped'; readonly reason: 'paused' | 'gone' };

export interface ReconcileReport {
  /** Registered or replaced this time. */
  readonly scheduled: readonly string[];
  /** Already on the queue with the cron the row has. */
  readonly kept: readonly string[];
  /** Removed: paused, deleted, or no longer runnable. */
  readonly unscheduled: readonly string[];
  /** Active rows whose schedule the harness would not take. */
  readonly refused: readonly { readonly watchId: string; readonly reason: string }[];
}

export interface WatchSchedulerOptions {
  readonly db: Pick<Database, 'db'>;
  readonly check: WatchCheck;
  /** Defaults to the Drizzle store on `db`; a port so the shell can be proved against a fake. */
  readonly store?: WatchStore;
}

/**
 * One tick. The row is read afresh rather than trusted from the payload:
 * the payload names the watch, and the row says whether it still wants a
 * check and what that check is about.
 */
export async function runWatchCheckJob(
  store: WatchStore,
  check: WatchCheck,
  job: WatchCheckJob,
): Promise<TickOutcome> {
  const watch = await store.loadWatch(job.watchId);
  if (watch === undefined) return { kind: 'skipped', reason: 'gone' };
  if (watch.status !== 'active') return { kind: 'skipped', reason: 'paused' };
  await check(watch);
  return { kind: 'checked' };
}

/**
 * Makes the check queue's schedules match the table: every active watch has
 * a schedule keyed by its id with the cron its row has; nothing else does. A
 * schedule already right is left alone, so a sweep that finds nothing to do
 * writes nothing.
 *
 * The API's door refuses a schedule the harness cannot run, so a refusal here
 * is a row that reached the table another way. It is written on the row as
 * `last_error`, and any schedule it had is removed, because a watch ticking
 * on a cron its row no longer has would be a check nobody asked for.
 */
export async function reconcileWatchSchedules(
  database: Pick<Database, 'db'>,
  harness: JobHarness,
): Promise<ReconcileReport> {
  const rows = await database.db
    .select({ id: watches.id, schedule: watches.schedule, status: watches.status })
    .from(watches);
  const wanted = new Map<string, string>();
  for (const row of rows) if (row.status === 'active') wanted.set(row.id, row.schedule);

  const existing = new Map<string, string>();
  for (const record of await harness.schedules(WATCH_CHECK_QUEUE)) existing.set(record.key, record.cron);

  const scheduled: string[] = [];
  const kept: string[] = [];
  const unscheduled: string[] = [];
  const refused: { watchId: string; reason: string }[] = [];

  for (const [watchId, cron] of wanted) {
    if (existing.get(watchId) === cron) {
      kept.push(watchId);
      continue;
    }
    try {
      const payload: WatchCheckJob = { watchId };
      await harness.schedule(WATCH_CHECK_QUEUE, cron, payload, { key: watchId });
      scheduled.push(watchId);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      refused.push({ watchId, reason });
      await database.db
        .update(watches)
        .set({ lastError: `schedule '${cron}' is not one the scheduler can run: ${reason}` })
        .where(eq(watches.id, watchId));
      if (existing.has(watchId)) {
        await harness.unschedule(WATCH_CHECK_QUEUE, watchId);
        unscheduled.push(watchId);
      }
    }
  }

  for (const key of existing.keys()) {
    if (wanted.has(key)) continue;
    await harness.unschedule(WATCH_CHECK_QUEUE, key);
    unscheduled.push(key);
  }

  return { scheduled, kept, unscheduled, refused };
}

/**
 * The worker-side registration: the tick handler, the reconcile sweep on its
 * own minute cron, and a first sweep right away so a worker that just came up
 * does not wait a minute to learn what to check.
 */
export function registerWatchScheduler(options: WatchSchedulerOptions): JobRegistration {
  return async (harness) => {
    const store = options.store ?? createDrizzleWatchStore(options.db);
    await harness.register<WatchCheckJob>(WATCH_CHECK_QUEUE, async (job) => {
      await runWatchCheckJob(store, options.check, job);
    });
    await harness.register(WATCH_RECONCILE_QUEUE, async () => {
      await reconcileWatchSchedules(options.db, harness);
    });
    await harness.schedule(WATCH_RECONCILE_QUEUE, WATCH_RECONCILE_CRON);
    await reconcileWatchSchedules(options.db, harness);
  };
}
