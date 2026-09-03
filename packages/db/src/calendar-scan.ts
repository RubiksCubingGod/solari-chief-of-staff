import {
  TERMINAL_TASK_STATUSES,
  autoCancelDue,
  calendarDayIn,
  cancellationQuestion,
  hourIn,
  reminderDue,
  reminderMessage,
  type AutoCancelDue,
  type CalendarAnnotation,
  type CalendarEntry,
  type IsoDate,
  type ReminderDue,
  type TransitionEventPayload,
} from '@chief-of-staff/core';
import { and, desc, eq, inArray } from 'drizzle-orm';

import {
  annotateCalendarItem,
  armAutoCancel,
  claimReminder,
  findAutoCancel,
  recordAutoCancel,
  recordReminder,
  settleAutoCancel,
  settleReminder,
  type CalendarDatabase,
} from './calendar-ledger.js';
import type { JobHarness, JobRegistration } from './jobs.js';
import {
  calendarAutoCancels,
  calendarItems,
  taskEvents,
  tasks,
  users,
  type CalendarItem,
  type CalendarReminder,
  type Task,
} from './schema.js';
import { enqueueTaskRun } from './task-ledger.js';

/**
 * The calendar scan (reminder-path and auto-cancel-path specs): the worker's
 * calendar heartbeat.
 *
 * Every hour, and once at startup, the scan reads every active entry, works
 * out what each person is owed on their own calendar day, and does it: a
 * reminder is sent, and a flagged subscription at its lead day gets a
 * cancellation task enqueued behind a confirm question. The discipline that
 * makes this safe to run twice, or to die halfway through, is
 * record-before-dispatch: a reminder is a row keyed by (entry, day) before
 * it is a message, and an auto-cancel is a row keyed by (entry, renewal)
 * before it is a task, in the same transaction as the task. The row's state -
 * not the scan's memory - decides whether anything happens. A second scan
 * finds the row and moves on; a scan that crashed after writing a reminder
 * row finds it pending and sends; two scans at once race on one `UPDATE` or
 * one unique key, and only the winner talks to the port or the queue.
 *
 * The scan also closes the loop: a cancellation task that has ended since the
 * last scan - succeeded, declined, failed, unanswered - has its ending written
 * onto its row and its entry, so the dashboard says what became of the
 * renewal without reading the task's trail, and so an ending that happened
 * in another process, the bot's decline above all, is marked by the same
 * hand as the rest.
 *
 * A person with no Telegram chat bound is the case the whole scan has to
 * stay honest about, because nothing here can reach them. Their reminder is
 * recorded as skipped and their entry is marked with why and what to do; a
 * flagged renewal of theirs is recorded as unlinked with the same reason
 * rather than armed, since a task whose first act is a question nobody can
 * receive would only park for a day and fail as unanswered.
 */

export const CALENDAR_SCAN_QUEUE = 'calendar.scan';
/**
 * Hourly rather than daily, so a reminder lands in a person's morning wherever
 * they are and an entry created over chat in the afternoon is picked up the
 * same day. The (entry, day) key is what keeps hourly scans from sending
 * daily reminders more than once.
 */
export const CALENDAR_SCAN_CRON = '0 * * * *';
/** The local hour from which a day's reminders and questions go out: after breakfast, not at midnight. */
export const REMINDER_SEND_FROM_HOUR = 9;
/** How many times a failing send is tried, one per scan, before the reminder is left as failed. */
export const REMINDER_SEND_ATTEMPTS = 3;

/**
 * The reason written onto an entry whose person cannot be reached, and what
 * to do about it. The bot's own instructions, word for word, because the
 * entry is where the person will read them.
 */
const NO_CHAT_BOUND = 'No Telegram chat is bound';
const HOW_TO_BIND =
  'Open your dashboard, ask it for a connection code, and send it to the bot as /start <code>.';
const NOBODY_TO_ASK = 'no Telegram chat is bound to ask over';

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

/** What a cancel task for the entry needs in its input, or why there can be no task. */
export type CancellationPlan =
  | { readonly kind: 'task'; readonly input: Readonly<Record<string, unknown>> }
  | { readonly kind: 'unlinked'; readonly reason: string };

/**
 * The auto-cancel arm's link to the playbooks. A port, because which
 * playbooks exist and which sites they sign in to is the playbooks package's
 * business, and this package is beneath it. The reason in an `unlinked` plan
 * is written onto the entry word for word, so it is a sentence for a person.
 */
export type CancellationPlanner = (item: CalendarItem) => Promise<CancellationPlan>;

export interface CalendarScanOptions {
  readonly db: CalendarDatabase;
  readonly send: ReminderSender;
  /**
   * The planner that links a flagged entry to its playbook. With it the
   * auto-cancel arm runs; without it this is the reminder scan alone.
   */
  readonly cancellations?: CancellationPlanner;
  /**
   * The harness cancellation tasks are queued on. The arm needs one: a scan
   * registered on a worker is lent the worker's own, and a scan run by hand
   * with a planner and no harness is a composition mistake, refused as one.
   */
  readonly harness?: JobHarness;
  readonly now?: () => Date;
  /** The local hour reminders and questions are held until; `REMINDER_SEND_FROM_HOUR` by default. */
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
  /** Cancellation tasks this scan enqueued. */
  readonly enqueued: number;
  /** Flagged entries this scan found nothing could act on, and marked. */
  readonly unlinked: number;
  /** Cancellation tasks whose ending this scan wrote onto their entries. */
  readonly settled: number;
}

interface CancellationArm {
  readonly harness: JobHarness;
  readonly plan: CancellationPlanner;
}

function autoCancelArm(options: CalendarScanOptions): CancellationArm | undefined {
  if (options.cancellations === undefined) return undefined;
  if (options.harness === undefined) {
    throw new Error('the auto-cancel arm needs a job harness to queue cancellation tasks on');
  }
  return { harness: options.harness, plan: options.cancellations };
}

type ReminderResult = 'delivered' | 'late' | 'failed' | 'skipped';
type AutoCancelResult = 'enqueued' | 'unlinked';

export async function runCalendarScan(options: CalendarScanOptions): Promise<CalendarScanReport> {
  const { db, send } = options;
  const now = (options.now ?? (() => new Date()))();
  const sendFromHour = options.sendFromHour ?? REMINDER_SEND_FROM_HOUR;
  const arm = autoCancelArm(options);
  const counts = {
    due: 0,
    delivered: 0,
    late: 0,
    failed: 0,
    skipped: 0,
    enqueued: 0,
    unlinked: 0,
    settled: 0,
  };

  // Endings first, so the marks the rest of the scan reads are current: an
  // entry whose cancellation went through is owed nothing more.
  counts.settled = await settleEndedCancellations(db, now);

  const rows = await db
    .select({ item: calendarItems, tz: users.tz, chatId: users.telegramChatId })
    .from(calendarItems)
    .innerJoin(users, eq(users.id, calendarItems.userId))
    .where(eq(calendarItems.status, 'active'));

  for (const { item, tz, chatId } of rows) {
    // Their day and their hour, not the server's.
    const today = calendarDayIn(now, tz);
    if (hourIn(now, tz) < sendFromHour) continue;
    const entry = entryOf(item);

    const reminder = reminderDue(entry, today);
    if (reminder !== undefined) {
      counts.due += 1;
      const result = await sendReminder(db, send, item, reminder, today, now);
      if (result !== undefined) counts[result] += 1;
    }

    if (arm !== undefined) {
      const cancel = autoCancelDue(entry, today);
      if (cancel !== undefined) {
        // Whether there is anyone to ask is known here, from the same row the
        // reminder was sent to; the planner is not consulted about a person
        // it could not put a question to.
        const result = await armCancellation(db, arm, item, cancel, now, chatId !== null);
        if (result !== undefined) counts[result] += 1;
      }
    }
  }

  return counts;
}

/**
 * One reminder, from its row to the port and back. Nothing when the row was
 * already done, or another scan got to it first.
 */
async function sendReminder(
  db: CalendarDatabase,
  send: ReminderSender,
  item: CalendarItem,
  due: ReminderDue,
  today: IsoDate,
  now: Date,
): Promise<ReminderResult | undefined> {
  const { reminder } = await recordReminder(db, item.id, due.dueOn);
  if (!dispatchable(reminder)) return undefined;
  // One winner per row. A loser is a scan that overlapped this one, and its
  // reminder is in better hands than its own.
  const claimed = await claimReminder(db, reminder);
  if (claimed === undefined) return undefined;

  // Everything below is on the wire or in the database; a throw here leaves
  // the row claimed and pending, which the next scan reads as "try again".
  const outcome = await send(item.userId, reminderMessage({ ...wording(item, due), today }));
  if (outcome.kind === 'unbound') {
    await settleReminder(db, claimed.id, { state: 'skipped_unbound', now });
    // The skip is on the entry as well as on its row: the row is the scan's
    // ledger and the entry is what the person reads. The rank rule keeps it
    // from covering a decision they already made about the entry.
    await annotateCalendarItem(db, item.id, 'needs_attention', {
      note: `${NO_CHAT_BOUND}, so the reminder owed on ${due.dueOn} was not sent. ${HOW_TO_BIND}`,
      now,
    });
    return 'skipped';
  }
  if (outcome.kind === 'failed') {
    await settleReminder(db, claimed.id, {
      state: 'failed',
      deliveryId: outcome.deliveryId,
      error: outcome.error,
      now,
    });
    return 'failed';
  }
  if (due.late) {
    await settleReminder(db, claimed.id, { state: 'late', deliveryId: outcome.deliveryId, now });
    // The mark is the dashboard's copy of the news; the rank rule keeps it
    // from covering a decision the person already made about the entry.
    await annotateCalendarItem(db, item.id, 'late', {
      note: `The reminder for ${due.dueOn} went out on ${today}.`,
      now,
    });
    return 'late';
  }
  await settleReminder(db, claimed.id, { state: 'delivered', deliveryId: outcome.deliveryId, now });
  return 'delivered';
}

/**
 * One renewal, from the entry to a task on the queue or a mark on the entry.
 * Nothing when the renewal was already decided, by this scan's past or by a
 * scan that overlapped it.
 */
async function armCancellation(
  db: CalendarDatabase,
  arm: CancellationArm,
  item: CalendarItem,
  due: AutoCancelDue,
  now: Date,
  reachable: boolean,
): Promise<AutoCancelResult | undefined> {
  // The row is the renewal's whole story; one that exists was decided.
  if ((await findAutoCancel(db, item.id, due.renewOn)) !== undefined) return undefined;

  // A person nobody can ask gets no task. The confirm gate would hold the
  // question for a day and then fail the task as unanswered, which is a mark
  // blaming them for a question they never received. Decided before the
  // planner is asked: which site the entry links to does not matter when
  // there is nobody to say yes.
  const plan: CancellationPlan = reachable
    ? await arm.plan(item)
    : { kind: 'unlinked', reason: NOBODY_TO_ASK };
  if (plan.kind === 'unlinked') {
    const record = await recordAutoCancel(db, item.id, due.renewOn, { state: 'unlinked' });
    if (!record.recorded) return undefined;
    await annotateCalendarItem(db, item.id, 'needs_attention', {
      note: `Auto-cancel could not be armed for the renewal on ${due.renewOn}: ${plan.reason}.`,
      now,
    });
    return 'unlinked';
  }

  // The question goes in the task's input, which is where the confirm gate
  // reads it: the task carries everything it needs to ask, and the person
  // sees the entry's own name and price.
  const confirm = cancellationQuestion({
    name: item.name,
    renewOn: due.renewOn,
    amountCents: item.amountCents,
  });
  const armed = await armAutoCancel(db, item.id, due.renewOn, {
    userId: item.userId,
    input: { ...plan.input, confirm },
  });
  if (!armed.recorded) return undefined;
  // Committed, so the job may go. A task this fails to send is queued with no
  // job, which is exactly what the reconcile sweep exists to pick up.
  await enqueueTaskRun({ db, harness: arm.harness }, armed.task.id);
  return 'enqueued';
}

/** How an enqueued cancellation ended, in the row's words and the entry's. */
interface Ending {
  readonly state: 'handled' | 'declined' | 'failed';
  readonly annotation: CalendarAnnotation;
  readonly note: string;
}

/**
 * Writes the ending of every cancellation task that has finished since the
 * last scan onto its row and its entry. The row is claimed by the `UPDATE`
 * that settles it, so of two scans that both read the task as finished
 * exactly one writes the mark; the entry's rank rule decides whether the
 * mark lands over what is there, and a stronger mark - a person's no over a
 * later failure - stays.
 */
async function settleEndedCancellations(db: CalendarDatabase, now: Date): Promise<number> {
  const ended = await db
    .select({ row: calendarAutoCancels, item: calendarItems, task: tasks, tz: users.tz })
    .from(calendarAutoCancels)
    .innerJoin(tasks, eq(tasks.id, calendarAutoCancels.taskId))
    .innerJoin(calendarItems, eq(calendarItems.id, calendarAutoCancels.itemId))
    .innerJoin(users, eq(users.id, calendarItems.userId))
    .where(
      and(
        eq(calendarAutoCancels.state, 'enqueued'),
        inArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
      ),
    );

  let settled = 0;
  for (const { row, item, task, tz } of ended) {
    const ending = endingOf(task, await lastTransition(db, task.id), calendarDayIn(now, tz), row.renewOn);
    if ((await settleAutoCancel(db, row.id, { state: ending.state, now })) === undefined) continue;
    await annotateCalendarItem(db, item.id, ending.annotation, { note: ending.note, now });
    settled += 1;
  }
  return settled;
}

function endingOf(
  task: Task,
  transition: TransitionEventPayload | undefined,
  today: IsoDate,
  renewOn: IsoDate,
): Ending {
  switch (task.status) {
    case 'succeeded':
      return {
        state: 'handled',
        annotation: 'handled',
        note: `Cancelled on ${today}, ahead of the renewal on ${renewOn}.`,
      };
    case 'cancelled':
      return {
        state: 'declined',
        annotation: 'declined',
        note: `You said no to cancelling it before the renewal on ${renewOn}.`,
      };
    default:
      return {
        state: 'failed',
        annotation: 'needs_attention',
        note: `The cancellation ahead of the renewal on ${renewOn} did not happen: ${failureReason(transition)}.`,
      };
  }
}

/** Why a task failed, in the words its last transition left, or the words its cause implies. */
function failureReason(transition: TransitionEventPayload | undefined): string {
  const detail = transition?.detail;
  if (typeof detail === 'object' && detail !== null && 'reason' in detail) {
    const reason = (detail as { readonly reason: unknown }).reason;
    if (typeof reason === 'string' && reason !== '') return reason;
  }
  switch (transition?.cause) {
    case 'timeout':
      return 'nobody answered the question in time';
    case 'orphaned':
      return 'the worker running it went away';
    default:
      return 'the task failed';
  }
}

async function lastTransition(
  db: CalendarDatabase,
  taskId: string,
): Promise<TransitionEventPayload | undefined> {
  const [event] = await db
    .select({ payload: taskEvents.payload })
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.type, 'transition')))
    .orderBy(desc(taskEvents.seq))
    .limit(1);
  return event === undefined ? undefined : (event.payload as TransitionEventPayload);
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
    // The worker's own harness runs the tasks the scan enqueues.
    const scan: CalendarScanOptions = { ...options, harness: options.harness ?? harness };
    await harness.register(CALENDAR_SCAN_QUEUE, async () => {
      await runCalendarScan(scan);
    });
    await harness.schedule(CALENDAR_SCAN_QUEUE, options.cron ?? CALENDAR_SCAN_CRON);
    await harness.enqueue(CALENDAR_SCAN_QUEUE, {});
  };
}
