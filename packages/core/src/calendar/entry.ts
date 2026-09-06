import type { CalendarItemKind, CalendarItemStatus } from '../index.js';

import type { CalendarAnnotation } from './annotation.js';
import { addDays, isIsoDate, type IsoDate } from './dates.js';

/**
 * Due computation: the one module both arms of the daily scan consume.
 *
 * An entry is a `subscription` scanned by its renewal or a `deadline` scanned
 * by its cancel-by. A reminder is owed from the lead day until the date
 * itself, and is late on every day of that window but the first - so a scan
 * that missed a day still sends, and says so. An auto-cancel is owed by a
 * flagged subscription from its own threshold until the renewal. Past the
 * date, nothing is owed: a reminder about a renewal that has happened is noise.
 */

/** What the engine reads off a calendar row. The row has more; this is the part the rules need. */
export interface CalendarEntry {
  readonly id: string;
  readonly kind: CalendarItemKind;
  readonly renewOn: IsoDate | null;
  readonly cancelBy: IsoDate | null;
  readonly status: CalendarItemStatus;
  /** How many days before the date the reminder goes out. */
  readonly reminderLeadDays: number;
  /** Whether the renewal should enqueue a cancellation task, behind a confirm. */
  readonly autoCancel: boolean;
  /** How many days before the renewal that task is enqueued. */
  readonly autoCancelLeadDays: number;
  readonly annotation: CalendarAnnotation | null;
}

/** A reminder owed today, keyed by the day it was first owed so a late send is still the same reminder. */
export interface ReminderDue {
  readonly entryId: string;
  readonly dueOn: IsoDate;
  readonly late: boolean;
  readonly key: string;
}

/** A cancellation task owed today, keyed by the renewal it is meant to beat. */
export interface AutoCancelDue {
  readonly entryId: string;
  readonly renewOn: IsoDate;
  readonly key: string;
}

export interface DueEntries {
  readonly reminders: readonly ReminderDue[];
  readonly autoCancels: readonly AutoCancelDue[];
}

/** The idempotence key of one reminder: one send per entry and day owed. */
export function reminderKey(entryId: string, dueOn: IsoDate): string {
  return `reminder:${entryId}:${dueOn}`;
}

/** The idempotence key of one auto-cancel: one task per entry and renewal. */
export function autoCancelKey(entryId: string, renewOn: IsoDate): string {
  return `auto-cancel:${entryId}:${renewOn}`;
}

/** The date an entry's kind is scanned by, or nothing when the row does not carry it. */
export function entryDate(entry: CalendarEntry): IsoDate | undefined {
  return (entry.kind === 'subscription' ? entry.renewOn : entry.cancelBy) ?? undefined;
}

function leadDays(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a whole number of days, got ${String(value)}`);
  }
  return value;
}

function today(value: IsoDate): IsoDate {
  if (!isIsoDate(value)) throw new Error(`'${String(value)}' is not a calendar day`);
  return value;
}

/** Whether the entry still has a story: active, and not already handled. */
function live(entry: CalendarEntry): boolean {
  return entry.status === 'active' && entry.annotation !== 'handled';
}

/** Whether `day` lies in the closed window from `from` to `to`. ISO days compare as strings. */
function within(day: IsoDate, from: IsoDate, to: IsoDate): boolean {
  return day >= from && day <= to;
}

export function reminderDue(entry: CalendarEntry, day: IsoDate): ReminderDue | undefined {
  const lead = leadDays(entry.reminderLeadDays, 'reminderLeadDays');
  const on = today(day);
  const date = entryDate(entry);
  if (date === undefined || !live(entry)) return undefined;
  const dueOn = addDays(date, -lead);
  if (!within(on, dueOn, date)) return undefined;
  return { entryId: entry.id, dueOn, late: on > dueOn, key: reminderKey(entry.id, dueOn) };
}

export function autoCancelDue(entry: CalendarEntry, day: IsoDate): AutoCancelDue | undefined {
  const lead = leadDays(entry.autoCancelLeadDays, 'autoCancelLeadDays');
  const on = today(day);
  if (entry.kind !== 'subscription' || !entry.autoCancel) return undefined;
  // Declined is the person's answer for this entry; handled is the end of it.
  if (!live(entry) || entry.annotation === 'declined') return undefined;
  const renewOn = entryDate(entry);
  if (renewOn === undefined) return undefined;
  if (!within(on, addDays(renewOn, -lead), renewOn)) return undefined;
  return { entryId: entry.id, renewOn, key: autoCancelKey(entry.id, renewOn) };
}

/** Everything owed on `day` across `entries`, in entry order, split by arm. */
export function dueEntries(entries: readonly CalendarEntry[], day: IsoDate): DueEntries {
  const reminders: ReminderDue[] = [];
  const autoCancels: AutoCancelDue[] = [];
  for (const entry of entries) {
    const reminder = reminderDue(entry, day);
    if (reminder !== undefined) reminders.push(reminder);
    const autoCancel = autoCancelDue(entry, day);
    if (autoCancel !== undefined) autoCancels.push(autoCancel);
  }
  return { reminders, autoCancels };
}
