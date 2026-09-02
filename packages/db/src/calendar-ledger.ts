import {
  CALENDAR_ANNOTATIONS,
  canAnnotate,
  type CalendarAnnotation,
  type CalendarAutoCancelState,
  type IsoDate,
} from '@chief-of-staff/core';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';

import {
  calendarAutoCancels,
  calendarItems,
  calendarReminders,
  type CalendarAutoCancel,
  type CalendarItem,
  type CalendarReminder,
} from './schema.js';
import type { TaskDatabase } from './task-ledger.js';

/**
 * The persisted half of calendar semantics (reminder-path spec).
 *
 * Three writes, each of which is safe to repeat. A mark on an entry lands only
 * if it outranks what is there, decided in the `UPDATE`'s own `WHERE` so two
 * scans cannot interleave a weaker mark over a stronger one. A reminder or an
 * auto-cancel is recorded with `ON CONFLICT DO NOTHING` against the unique key
 * the migration declares, so the second writer gets the first writer's row
 * back and knows it was second. That is the whole of "record before dispatch":
 * whoever holds the freshly inserted row is the one who sends.
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

export interface AutoCancelDecision {
  readonly state: CalendarAutoCancelState;
  /** The cancellation task, when one was enqueued. */
  readonly taskId?: string;
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
  const [existing] = await db
    .select()
    .from(calendarAutoCancels)
    .where(and(eq(calendarAutoCancels.itemId, itemId), eq(calendarAutoCancels.renewOn, renewOn)));
  if (existing === undefined) {
    throw new Error(`auto-cancel ${itemId} for ${renewOn} was neither inserted nor found`);
  }
  return { recorded: false, autoCancel: existing };
}
