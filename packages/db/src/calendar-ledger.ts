import {
  CALENDAR_ANNOTATIONS,
  canAnnotate,
  type CalendarAnnotation,
  type CalendarAutoCancelState,
  type CalendarReminderState,
  type IsoDate,
} from '@chief-of-staff/core';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';

import {
  calendarAutoCancels,
  calendarItems,
  calendarReminders,
  tasks,
  type CalendarAutoCancel,
  type CalendarItem,
  type CalendarReminder,
  type Task,
} from './schema.js';
import type { TaskDatabase } from './task-ledger.js';

/**
 * The persisted half of calendar semantics (reminder-path and auto-cancel-path
 * specs).
 *
 * Every write here is safe to repeat. A mark on an entry lands only if it
 * outranks what is there, decided in the `UPDATE`'s own `WHERE` so two scans
 * cannot interleave a weaker mark over a stronger one. A reminder or an
 * auto-cancel is recorded with `ON CONFLICT DO NOTHING` against the unique key
 * the migration declares, so the second writer gets the first writer's row
 * back and knows it was second. That is the whole of "record before dispatch":
 * whoever holds the freshly inserted row is the one who sends, or whose
 * transaction the cancellation task was created in - and, because a crashed
 * scan leaves its row behind for the next one, whoever wins the claim on a
 * row that is still pending, or the settlement of one whose task has ended.
 */

export type CalendarDatabase = TaskDatabase;

export interface AnnotateOptions {
  /** Why the mark was left, in words a person can read on the dashboard. */
  readonly note?: string;
  readonly now?: Date;
}

export type AnnotateOutcome =
  | { readonly applied: true; readonly item: CalendarItem }
  | { readonly applied: false; readonly reason: 'not_found' }
  | { readonly applied: false; readonly reason: 'outranked'; readonly current: CalendarAnnotation };

export async function annotateCalendarItem(
  db: CalendarDatabase,
  itemId: string,
  annotation: CalendarAnnotation,
  options: AnnotateOptions = {},
): Promise<AnnotateOutcome> {
  // Never empty: a mark may always be written over itself.
  const replaceable = CALENDAR_ANNOTATIONS.filter((current) => canAnnotate(current, annotation));
  const [updated] = await db
    .update(calendarItems)
    .set({
      annotation,
      annotationNote: options.note ?? null,
      annotatedAt: options.now ?? new Date(),
    })
    .where(
      and(
        eq(calendarItems.id, itemId),
        or(isNull(calendarItems.annotation), inArray(calendarItems.annotation, replaceable)),
      ),
    )
    .returning();
  if (updated !== undefined) return { applied: true, item: updated };

  const [current] = await db
    .select({ annotation: calendarItems.annotation })
    .from(calendarItems)
    .where(eq(calendarItems.id, itemId));
  // An unmarked row would have taken the update, so a null here means the row
  // went away between the two statements: the same answer as no row at all.
  if (current === undefined || current.annotation === null) {
    return { applied: false, reason: 'not_found' };
  }
  return { applied: false, reason: 'outranked', current: current.annotation };
}

/** The row for one key, and whether this call was the one that wrote it. */
export type ReminderRecord =
  | { readonly recorded: true; readonly reminder: CalendarReminder }
  | { readonly recorded: false; readonly reminder: CalendarReminder };

export type AutoCancelRecord =
  | { readonly recorded: true; readonly autoCancel: CalendarAutoCancel }
  | { readonly recorded: false; readonly autoCancel: CalendarAutoCancel };

/** Records that a reminder for `dueOn` is owed. One row per (entry, day); a repeat gets the first row. */
export async function recordReminder(
  db: CalendarDatabase,
  itemId: string,
  dueOn: IsoDate,
): Promise<ReminderRecord> {
  const [inserted] = await db
    .insert(calendarReminders)
    .values({ itemId, dueOn })
    .onConflictDoNothing({ target: [calendarReminders.itemId, calendarReminders.dueOn] })
    .returning();
  if (inserted !== undefined) return { recorded: true, reminder: inserted };
  const [existing] = await db
    .select()
    .from(calendarReminders)
    .where(and(eq(calendarReminders.itemId, itemId), eq(calendarReminders.dueOn, dueOn)));
  if (existing === undefined) {
    throw new Error(`reminder ${itemId} for ${dueOn} was neither inserted nor found`);
  }
  return { recorded: false, reminder: existing };
}

/**
 * Takes a reminder for one send attempt, if nobody else has since the caller
 * read it. The attempt counter doubles as the lock: the `UPDATE` only lands
 * on the count the caller saw, so of two scans holding the same row exactly
 * one gets it back. A row claimed by a scan that then died stays pending with
 * the attempt counted, which is what lets the next scan retry it - boundedly.
 */
export async function claimReminder(
  db: CalendarDatabase,
  reminder: CalendarReminder,
): Promise<CalendarReminder | undefined> {
  const [claimed] = await db
    .update(calendarReminders)
    .set({ attempts: reminder.attempts + 1 })
    .where(
      and(eq(calendarReminders.id, reminder.id), eq(calendarReminders.attempts, reminder.attempts)),
    )
    .returning();
  return claimed;
}

export interface ReminderSettlement {
  readonly state: CalendarReminderState;
  /** The delivery row the send was recorded as, when the door recorded one. */
  readonly deliveryId?: string | undefined;
  /** What went wrong, kept only on a failure. */
  readonly error?: string | undefined;
  readonly now?: Date;
}

/** Writes down how a claimed send ended. */
export async function settleReminder(
  db: CalendarDatabase,
  reminderId: string,
  settlement: ReminderSettlement,
): Promise<CalendarReminder> {
  const [settled] = await db
    .update(calendarReminders)
    .set({
      state: settlement.state,
      deliveryId: settlement.deliveryId ?? null,
      error: settlement.state === 'failed' ? (settlement.error ?? null) : null,
      settledAt: settlement.now ?? new Date(),
    })
    .where(eq(calendarReminders.id, reminderId))
    .returning();
  if (settled === undefined) throw new Error(`reminder ${reminderId} vanished before it settled`);
  return settled;
}

export interface AutoCancelDecision {
  readonly state: CalendarAutoCancelState;
  /** The cancellation task, when one was enqueued. */
  readonly taskId?: string;
}

/** The row for one renewal, if the arm has decided it. */
export async function findAutoCancel(
  db: CalendarDatabase,
  itemId: string,
  renewOn: IsoDate,
): Promise<CalendarAutoCancel | undefined> {
  const [existing] = await db
    .select()
    .from(calendarAutoCancels)
    .where(and(eq(calendarAutoCancels.itemId, itemId), eq(calendarAutoCancels.renewOn, renewOn)));
  return existing;
}

/** Records the auto-cancel decision for `renewOn`. One row per (entry, renewal); a repeat gets the first row. */
export async function recordAutoCancel(
  db: CalendarDatabase,
  itemId: string,
  renewOn: IsoDate,
  decision: AutoCancelDecision,
): Promise<AutoCancelRecord> {
  const [inserted] = await db
    .insert(calendarAutoCancels)
    .values({ itemId, renewOn, state: decision.state, taskId: decision.taskId ?? null })
    .onConflictDoNothing({ target: [calendarAutoCancels.itemId, calendarAutoCancels.renewOn] })
    .returning();
  if (inserted !== undefined) return { recorded: true, autoCancel: inserted };
  const existing = await findAutoCancel(db, itemId, renewOn);
  if (existing === undefined) {
    throw new Error(`auto-cancel ${itemId} for ${renewOn} was neither inserted nor found`);
  }
  return { recorded: false, autoCancel: existing };
}

/** The cancellation task the arm creates for a renewal: whose it is, and what its playbook needs. */
export interface AutoCancelTask {
  readonly userId: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export type AutoCancelArm =
  | { readonly recorded: true; readonly autoCancel: CalendarAutoCancel; readonly task: Task }
  | { readonly recorded: false; readonly autoCancel: CalendarAutoCancel };

/**
 * Records that a cancellation task was enqueued for `renewOn` and creates
 * the task, in one transaction: the row is the idempotence key, so the task
 * exists exactly when the row says it does. A second caller for the same
 * renewal - a scan that overlapped this one, or the next hour's - gets the
 * first caller's row and creates nothing. The run job is the caller's to
 * send once this has committed: a job for a task that rolled back would be
 * a job for nothing, and a task whose job was never sent is what the
 * reconcile sweep exists for.
 */
export function armAutoCancel(
  db: CalendarDatabase,
  itemId: string,
  renewOn: IsoDate,
  task: AutoCancelTask,
): Promise<AutoCancelArm> {
  return db.transaction(async (tx): Promise<AutoCancelArm> => {
    const [inserted] = await tx
      .insert(calendarAutoCancels)
      .values({ itemId, renewOn, state: 'enqueued' })
      .onConflictDoNothing({ target: [calendarAutoCancels.itemId, calendarAutoCancels.renewOn] })
      .returning();
    if (inserted === undefined) {
      const existing = await findAutoCancel(tx, itemId, renewOn);
      if (existing === undefined) {
        throw new Error(`auto-cancel ${itemId} for ${renewOn} was neither inserted nor found`);
      }
      return { recorded: false, autoCancel: existing };
    }
    const [created] = await tx
      .insert(tasks)
      .values({ userId: task.userId, kind: 'cancel', mode: 'playbook', input: task.input })
      .returning();
    if (created === undefined) throw new Error(`the cancel task for ${itemId} was not created`);
    const [linked] = await tx
      .update(calendarAutoCancels)
      .set({ taskId: created.id })
      .where(eq(calendarAutoCancels.id, inserted.id))
      .returning();
    if (linked === undefined) throw new Error(`auto-cancel ${inserted.id} vanished before it was linked`);
    return { recorded: true, autoCancel: linked, task: created };
  });
}

export interface AutoCancelSettlement {
  /** How the task ended, in the row's words. */
  readonly state: Extract<CalendarAutoCancelState, 'handled' | 'declined' | 'failed'>;
  readonly now?: Date;
}

/**
 * Writes how an enqueued cancellation ended onto its row, if nobody has yet.
 * Guarded on the row still being `enqueued`, so of two scans that both read
 * the task as finished exactly one gets the row back - and that one writes
 * the mark on the entry.
 */
export async function settleAutoCancel(
  db: CalendarDatabase,
  autoCancelId: string,
  settlement: AutoCancelSettlement,
): Promise<CalendarAutoCancel | undefined> {
  const [settled] = await db
    .update(calendarAutoCancels)
    .set({ state: settlement.state, settledAt: settlement.now ?? new Date() })
    .where(and(eq(calendarAutoCancels.id, autoCancelId), eq(calendarAutoCancels.state, 'enqueued')))
    .returning();
  return settled;
}
