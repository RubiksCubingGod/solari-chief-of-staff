import {
  BOOK_SLOT_TASK_KIND,
  bookSlotInput,
  type NewObservation,
  type ObservationRecord,
  type SlotCondition,
  type SlotListing,
  type WatchPatch,
  type WatchRecord,
} from '@chief-of-staff/core';
import { observations, tasks, watches, type Database } from '@chief-of-staff/db';
import { and, eq } from 'drizzle-orm';

import { columnsOf, toObservationRecord, valuesOf } from './store.js';

/**
 * What a slot watch does when a slot appears: it does not book, it arms.
 *
 * Arming is one transaction - the watch is paused, the triggered observation
 * is written, and a `book_slot` task is queued - and it is conditional on the
 * watch still being active. Two checks that both see the slot both try;
 * the second finds the row already paused, writes its observation as not
 * triggered, and queues nothing. That conditional update is the whole race
 * story: there is no lock a crashed worker could keep, and no second task a
 * retried tick could queue. The enqueue onto the run queue happens after the
 * commit, so a task the process dies on before enqueueing is still on the
 * ledger, queued, for the reconciler to pick up.
 */
export interface SlotTriggerRequest {
  readonly watch: WatchRecord;
  readonly condition: SlotCondition;
  /** The slot the comparator picked. */
  readonly slot: SlotListing;
  /** The observation the check would have recorded: triggered, with the listing. */
  readonly observation: NewObservation;
  /** The row patch the check would have applied after that observation. */
  readonly patch: WatchPatch;
}

export type SlotTriggerResult =
  | { readonly armed: true; readonly taskId: string; readonly observation: ObservationRecord }
  | { readonly armed: false; readonly reason: string; readonly observation: ObservationRecord };

export interface SlotTriggerPort {
  arm(request: SlotTriggerRequest): Promise<SlotTriggerResult>;
}

/** Runs once the task is committed: the worker's own enqueue, or nothing in a proof of the transaction alone. */
export type TaskRunEnqueuer = (taskId: string) => Promise<void>;

export function createDrizzleSlotTrigger(database: Pick<Database, 'db'>, enqueue?: TaskRunEnqueuer): SlotTriggerPort {
  const { db } = database;
  return {
    async arm({ watch, condition, slot, observation, patch }) {
      const result = await db.transaction(async (tx): Promise<SlotTriggerResult> => {
        const [paused] = await tx
          .update(watches)
          .set({ ...columnsOf(patch), status: 'paused' })
          .where(and(eq(watches.id, watch.id), eq(watches.status, 'active')))
          .returning({ id: watches.id });
        if (paused === undefined) {
          const [row] = await tx
            .insert(observations)
            .values(valuesOf(watch.id, { ...observation, triggered: false }))
            .returning();
          return {
            armed: false,
            reason: `watch ${watch.id} is already paused: a booking is pending, so this sighting queues nothing`,
            observation: toObservationRecord(must(row)),
          };
        }
        const [row] = await tx.insert(observations).values(valuesOf(watch.id, observation)).returning();
        const [task] = await tx
          .insert(tasks)
          .values({
            userId: watch.userId,
            kind: BOOK_SLOT_TASK_KIND,
            mode: 'playbook',
            input: bookSlotInput(watch, condition, slot),
          })
          .returning({ id: tasks.id });
        return { armed: true, taskId: must(task).id, observation: toObservationRecord(must(row)) };
      });
      if (result.armed && enqueue !== undefined) await enqueue(result.taskId);
      return result;
    },
  };
}

export interface RearmOptions {
  /**
   * Whether the last value is forgotten too. After a slot that went, yes: a
   * calendar that lists the same slot again is news. After a person declined
   * a slot, no: the same slot listed again is the one they said no to.
   */
  readonly clearBaseline: boolean;
}

/**
 * Sets a paused watch active again, and nothing else. No observation is
 * written and no comparison is made: the next scheduled check has to fetch
 * and extract afresh before anything can trigger, so a stale sighting can
 * never re-arm the reflex on its own. Returns whether a paused row was there
 * to re-arm.
 */
export async function rearmWatch(
  database: Pick<Database, 'db'>,
  watchId: string,
  options: RearmOptions,
): Promise<boolean> {
  const rows = await database.db
    .update(watches)
    .set({ status: 'active', ...(options.clearBaseline ? { lastValue: null } : {}) })
    .where(and(eq(watches.id, watchId), eq(watches.status, 'paused')))
    .returning({ id: watches.id });
  return rows.length > 0;
}

function must<T>(row: T | undefined): T {
  if (row === undefined) throw new Error('an insert with RETURNING gave no row back');
  return row;
}
