import {
  hourIn,
  calendarDayIn,
  reminderDue,
  reminderMessage,
  type CalendarEntry,
  type ReminderDue,
} from '@chief-of-staff/core';
import { eq } from 'drizzle-orm';

import {
  annotateCalendarItem,
  claimReminder,
  recordReminder,
  settleReminder,
  type CalendarDatabase,
} from './calendar-ledger.js';
import type { JobRegistration } from './jobs.js';
import { calendarItems, users, type CalendarItem, type CalendarReminder } from './schema.js';

/**
 * The reminder scan (reminder-path spec): the worker's calendar heartbeat.
 *
 * Every hour, and once at startup, the scan reads every active entry, works
 * out what each person is owed on their own calendar day, and sends it. The
 * discipline that makes this safe to run twice, or to die halfway through, is
 * record-before-dispatch: a reminder is a row keyed by (entry, day) before it
 * is a message, and the row's state - not the scan's memory - decides whether
 * anything goes out. A second scan finds the row delivered and moves on; a
 * scan that crashed after writing it finds it pending and sends; two scans at
 * once race on one `UPDATE`, and only the winner talks to the port.
 */

export const CALENDAR_SCAN_QUEUE = 'calendar.scan';
/**
 * Hourly rather than daily, so a reminder lands in a person's morning wherever
 * they are and an entry created over chat in the afternoon is picked up the
 * same day. The (entry, day) key is what keeps hourly scans from sending
 * daily reminders more than once.
 */
export const CALENDAR_SCAN_CRON = '0 * * * *';
/** The local hour from which a day's reminders go out: after breakfast, not at midnight. */
export const REMINDER_SEND_FROM_HOUR = 9;
/** How many times a failing send is tried, one per scan, before the reminder is left as failed. */
export const REMINDER_SEND_ATTEMPTS = 3;

/** What became of one message handed to the port. */
export type ReminderSendOutcome =
  | { readonly kind: 'sent'; readonly deliveryId?: string | undefined }
  | { readonly kind: 'failed'; readonly deliveryId?: string | undefined; readonly error: string }
  /** Nobody to send to; nothing was attempted. */
  | { readonly kind: 'unbound' };

/**
 * The send port. A thrown error is a crash - the database, the process - and
 * propagates so the job harness retries the scan; anything that happened to
 * the message itself is an outcome.
 */
export type ReminderSender = (userId: string, text: string) => Promise<ReminderSendOutcome>;

export interface CalendarScanOptions {
  readonly db: CalendarDatabase;
  readonly send: ReminderSender;
  readonly now?: () => Date;
  /** The local hour reminders are held until; `REMINDER_SEND_FROM_HOUR` by default. */
  readonly sendFromHour?: number;
  readonly cron?: string;
}

/** What one scan did, for the log line and the proofs. */
export interface CalendarScanReport {
  /** Reminders owed at this hour, whatever state they were already in. */
  readonly due: number;
  readonly delivered: number;
  readonly late: number;
  readonly failed: number;
  readonly skipped: number;
}

export async function runCalendarScan(options: CalendarScanOptions): Promise<CalendarScanReport> {
  const { db, send } = options;
  const now = (options.now ?? (() => new Date()))();
  const sendFromHour = options.sendFromHour ?? REMINDER_SEND_FROM_HOUR;
  const counts = { due: 0, delivered: 0, late: 0, failed: 0, skipped: 0 };

  const rows = await db
    .select({ item: calendarItems, tz: users.tz })
    .from(calendarItems)
    .innerJoin(users, eq(users.id, calendarItems.userId))
    .where(eq(calendarItems.status, 'active'));

  for (const { item, tz } of rows) {
    // Their day and their hour, not the server's.
    const today = calendarDayIn(now, tz);
    const due = reminderDue(entryOf(item), today);
    if (due === undefined || hourIn(now, tz) < sendFromHour) continue;
    counts.due += 1;

    const { reminder } = await recordReminder(db, item.id, due.dueOn);
    if (!dispatchable(reminder)) continue;
    // One winner per row. A loser is a scan that overlapped this one, and its
    // reminder is in better hands than its own.
    const claimed = await claimReminder(db, reminder);
    if (claimed === undefined) continue;

    // Everything below is on the wire or in the database; a throw here leaves
    // the row claimed and pending, which the next scan reads as "try again".
    const outcome = await send(item.userId, reminderMessage({ ...wording(item, due), today }));
    if (outcome.kind === 'unbound') {
      await settleReminder(db, claimed.id, { state: 'skipped_unbound', now });
      counts.skipped += 1;
    } else if (outcome.kind === 'failed') {
      await settleReminder(db, claimed.id, {
        state: 'failed',
        deliveryId: outcome.deliveryId,
        error: outcome.error,
        now,
      });
      counts.failed += 1;
    } else if (due.late) {
      await settleReminder(db, claimed.id, { state: 'late', deliveryId: outcome.deliveryId, now });
      // The mark is the dashboard's copy of the news; the rank rule keeps it
      // from covering a decision the person already made about the entry.
      await annotateCalendarItem(db, item.id, 'late', {
        note: `The reminder for ${due.dueOn} went out on ${today}.`,
        now,
      });
      counts.late += 1;
    } else {
      await settleReminder(db, claimed.id, {
        state: 'delivered',
        deliveryId: outcome.deliveryId,
        now,
      });
      counts.delivered += 1;
    }
  }

  return counts;
}

/**
 * Whether the row still wants a send: never begun, or failed with attempts to
 * spare. Delivered and late are done; a skip is a fact about the person, not
 * a failure to retry.
 */
function dispatchable(reminder: CalendarReminder): boolean {
  if (reminder.attempts >= REMINDER_SEND_ATTEMPTS) return false;
  return reminder.state === 'pending' || reminder.state === 'failed';
}

function entryOf(item: CalendarItem): CalendarEntry {
  return {
    id: item.id,
    kind: item.kind,
    renewOn: item.renewOn,
    cancelBy: item.cancelBy,
    status: item.status,
    reminderLeadDays: item.reminderLeadDays,
    autoCancel: item.autoCancel,
    autoCancelLeadDays: item.autoCancelLeadDays,
    annotation: item.annotation,
  };
}

function wording(item: CalendarItem, due: ReminderDue) {
  return {
    name: item.name,
    kind: item.kind,
    // Owed, so the date its kind is scanned by is there.
    date: (item.kind === 'subscription' ? item.renewOn : item.cancelBy) ?? due.dueOn,
    amountCents: item.amountCents,
    late: due.late,
  };
}

/**
 * The scan on the worker: a queue with one handler, a cron on it, and one
 * scan enqueued at startup so a worker that was down for a day catches up
 * without waiting for the top of the hour. Enqueued rather than run inline
 * for the same reason the cron is a queue: the harness's retry policy is what
 * turns a scan that died into a scan that ran.
 */
export function registerCalendarScan(options: CalendarScanOptions): JobRegistration {
  return async (harness) => {
    await harness.register(CALENDAR_SCAN_QUEUE, async () => {
      await runCalendarScan(options);
    });
    await harness.schedule(CALENDAR_SCAN_QUEUE, options.cron ?? CALENDAR_SCAN_CRON);
    await harness.enqueue(CALENDAR_SCAN_QUEUE, {});
  };
}
