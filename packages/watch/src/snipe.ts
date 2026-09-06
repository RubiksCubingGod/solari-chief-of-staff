import {
  BOOK_SLOT_TASK_KIND,
  TERMINAL_TASK_STATUSES,
  bookSlotRefusal,
  bookingDedupKey,
  parseBookSlotBooked,
  parseBookSlotInput,
  type BookSlotInput,
  type BookingEvent,
  type BookingOutcome,
  type NotifierPort,
  type SlotListing,
  type StepEventPayload,
  type TransitionEventPayload,
} from '@chief-of-staff/core';
import {
  appendTaskEvent,
  taskEvents,
  tasks,
  type Database,
  type JobRegistration,
  type Task,
  type TaskEvent,
} from '@chief-of-staff/db';
import { and, asc, eq, inArray, notExists, sql } from 'drizzle-orm';

import { rearmWatch } from './slot-trigger.js';

/**
 * What the watch does once its booking task has come to something.
 *
 * The trigger paused the watch and queued the task, and nothing touches the
 * row until the task is terminal. Then exactly one of three things happens.
 * Booked: the watch stays paused - its job is done - and the person gets the
 * reference. The slot went, or the person passed on it: the watch is set
 * active again, with the baseline cleared for a slot that went (the same slot
 * listed again is news) and kept for one the person declined (it is not).
 * Anything else - the site blocked the booking, a guardrail tripped, the
 * worker died - leaves the watch paused for a person to look at, and says so.
 *
 * A consequence is applied in one transaction under the task's row lock and
 * recorded as a `snipe` step on the task's own trail, which is what makes it
 * happen once. The task engine's settled hook applies it the moment this
 * worker settles a run; the sweep applies it for a task a channel settled - a
 * decline, an expiry, an orphan - or one the hook could not finish. Either
 * finds a task already marked and leaves it alone. The notifier is told inside
 * the transaction, so a delivery that fails rolls the re-arm back with it and
 * the sweep tries the whole thing again, under the same dedup key.
 */

/** The step on a booking task's trail that says what became of its watch. */
export const SNIPE_STEP = 'snipe';
/** The sweep's queue and cadence: a task settled elsewhere waits at most a minute. */
export const WATCH_SNIPE_QUEUE = 'watch-check.snipe';
export const WATCH_SNIPE_CRON = '* * * * *';

export type SnipeConsequence =
  | { readonly kind: 'booked'; readonly reference: string; readonly bookedAt: string }
  | { readonly kind: 'rearm'; readonly clearBaseline: boolean; readonly reason: string }
  | { readonly kind: 'paused'; readonly reason: string };

export interface SnipePorts {
  readonly db: Pick<Database, 'db'>;
  readonly notifier: NotifierPort;
  readonly now?: () => Date;
}

export type SnipeReport =
  | {
      readonly kind: 'settled';
      readonly taskId: string;
      readonly watchId: string;
      readonly consequence: SnipeConsequence;
      /** Whether a paused row was there to re-arm; false for every consequence that leaves the watch paused. */
      readonly moved: boolean;
    }
  | { readonly kind: 'skipped'; readonly taskId: string; readonly reason: string };

export interface SnipeSweepReport {
  readonly settled: readonly string[];
  readonly failed: readonly { readonly taskId: string; readonly reason: string }[];
}

/**
 * The consequence table: from a terminal task, its last transition and the
 * slot it was about, to what the watch does. Undefined while the task is not
 * terminal.
 */
export function snipeConsequence(
  task: Pick<Task, 'status' | 'result'>,
  last: TransitionEventPayload | undefined,
  slot: SlotListing,
): SnipeConsequence | undefined {
  switch (task.status) {
    case 'succeeded': {
      const booked = parseBookSlotBooked(task.result);
      return booked === undefined
        ? { kind: 'paused', reason: `the booking task succeeded without a confirmation reference for ${slot.label}` }
        : { kind: 'booked', reference: booked.reference, bookedAt: booked.bookedAt };
    }
    case 'cancelled':
      return {
        kind: 'rearm',
        clearBaseline: false,
        reason:
          last?.cause === 'declined'
            ? `the person declined to book ${slot.label}`
            : `the booking of ${slot.label} was cancelled`,
      };
    case 'failed':
      return failedConsequence(last, slot);
    default:
      return undefined;
  }
}

function failedConsequence(last: TransitionEventPayload | undefined, slot: SlotListing): SnipeConsequence {
  const reason = reasonOf(last, slot);
  switch (last?.cause) {
    case 'refused': {
      const refusal = bookSlotRefusal(last.detail);
      if (refusal === 'slot-gone') return { kind: 'rearm', clearBaseline: true, reason };
      if (refusal === 'not-confirmed') return { kind: 'rearm', clearBaseline: false, reason };
      return { kind: 'paused', reason };
    }
    case 'timeout':
      // Nobody answered. The slot they were not asked about in time is not
      // offered again, but the next one is: a person who missed a message has
      // not stopped wanting the appointment.
      return { kind: 'rearm', clearBaseline: false, reason: `nobody answered before the deadline, so ${slot.label} was not booked` };
    default:
      return { kind: 'paused', reason };
  }
}

/** The transition's own reason when the engine wrote one, else the cause. */
function reasonOf(last: TransitionEventPayload | undefined, slot: SlotListing): string {
  const detail: unknown = last?.detail;
  if (typeof detail === 'object' && detail !== null && 'reason' in detail && typeof detail.reason === 'string') {
    return detail.reason;
  }
  return `the booking of ${slot.label} failed${last === undefined ? '' : ` (${last.cause})`}`;
}

export function outcomeOf(consequence: SnipeConsequence): BookingOutcome {
  switch (consequence.kind) {
    case 'booked':
      return 'booked';
    case 'rearm':
      return 'rearmed';
    case 'paused':
      return 'paused';
  }
}

function describeConsequence(consequence: SnipeConsequence, slot: SlotListing): string {
  return consequence.kind === 'booked'
    ? `${slot.label} is booked: reference ${consequence.reference}`
    : consequence.reason;
}

/** The event the person hears: the task, the slot, what became of the watch, and the reference when there is one. */
export function bookingEventFor(
  input: BookSlotInput,
  task: Pick<Task, 'id' | 'userId'>,
  consequence: SnipeConsequence,
  occurredAt: Date,
): BookingEvent {
  const outcome = outcomeOf(consequence);
  return {
    type: 'booking',
    watchId: input.watchId,
    userId: task.userId,
    url: input.url,
    occurredAt: occurredAt.toISOString(),
    dedupKey: bookingDedupKey(input.watchId, task.id, outcome),
    taskId: task.id,
    slot: input.slot,
    outcome,
    reference: consequence.kind === 'booked' ? consequence.reference : null,
    reason: describeConsequence(consequence, input.slot),
  };
}

/** The trail's record of the consequence: the same words the person got, and for a re-arm, whether the row moved. */
export function snipeStep(
  input: BookSlotInput,
  consequence: SnipeConsequence,
  moved: boolean,
): StepEventPayload {
  const reason = describeConsequence(consequence, input.slot);
  return {
    name: SNIPE_STEP,
    outcome: outcomeOf(consequence),
    detail:
      consequence.kind === 'rearm'
        ? { watchId: input.watchId, reason, clearBaseline: consequence.clearBaseline, moved }
        : { watchId: input.watchId, reason },
  };
}

function isSnipeStep(event: TaskEvent): boolean {
  return event.type === 'step' && (event.payload as StepEventPayload).name === SNIPE_STEP;
}

function lastTransition(events: readonly TaskEvent[]): TransitionEventPayload | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'transition') return event.payload as TransitionEventPayload;
  }
  return undefined;
}

function skipped(taskId: string, reason: string): SnipeReport {
  return { kind: 'skipped', taskId, reason };
}

/**
 * Applies the consequence of one task, once. Anything that is not a terminal
 * booking task, or that has its `snipe` step already, is reported as skipped
 * and left alone.
 */
export function settleSnipe(ports: SnipePorts, taskId: string): Promise<SnipeReport> {
  const now = ports.now ?? (() => new Date());
  return ports.db.db.transaction(async (tx): Promise<SnipeReport> => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('update');
    if (task === undefined) return skipped(taskId, 'no such task');
    if (task.kind !== BOOK_SLOT_TASK_KIND) return skipped(taskId, `a ${task.kind} task is not a booking`);
    const input = parseBookSlotInput(task.input);
    if (input === undefined) return skipped(taskId, 'the task input is not a book_slot input');
    const events = await tx
      .select()
      .from(taskEvents)
      .where(eq(taskEvents.taskId, taskId))
      .orderBy(asc(taskEvents.seq));
    if (events.some(isSnipeStep)) return skipped(taskId, 'already settled');
    const consequence = snipeConsequence(task, lastTransition(events), input.slot);
    if (consequence === undefined) return skipped(taskId, `the task is still ${task.status}`);

    const moved =
      consequence.kind === 'rearm'
        ? await rearmWatch({ db: tx }, input.watchId, { clearBaseline: consequence.clearBaseline })
        : false;
    await ports.notifier.notify(bookingEventFor(input, task, consequence, now()));
    await appendTaskEvent(tx, taskId, 'step', snipeStep(input, consequence, moved));
    return { kind: 'settled', taskId, watchId: input.watchId, consequence, moved };
  });
}

/**
 * Every terminal booking task with no `snipe` step yet, settled in the order
 * they finished. A task whose settlement throws - the notifier was down - is
 * reported and tried again next sweep.
 */
export async function settleSnipes(ports: SnipePorts): Promise<SnipeSweepReport> {
  const { db } = ports.db;
  const marked = db
    .select({ one: sql`1` })
    .from(taskEvents)
    .where(
      and(
        eq(taskEvents.taskId, tasks.id),
        eq(taskEvents.type, 'step'),
        sql`${taskEvents.payload}->>'name' = ${SNIPE_STEP}`,
      ),
    );
  const unsettled = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.kind, BOOK_SLOT_TASK_KIND),
        inArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
        notExists(marked),
      ),
    )
    .orderBy(asc(tasks.finishedAt), asc(tasks.createdAt));

  const settled: string[] = [];
  const failed: { taskId: string; reason: string }[] = [];
  for (const { id } of unsettled) {
    try {
      const report = await settleSnipe(ports, id);
      if (report.kind === 'settled') settled.push(id);
    } catch (error: unknown) {
      failed.push({ taskId: id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { settled, failed };
}

/**
 * The sweep on a worker: on its schedule, and once right away, because a
 * worker that just started may have missed a hook when it died.
 */
export function registerSnipeSweep(ports: SnipePorts): JobRegistration {
  return async (harness) => {
    await harness.register(WATCH_SNIPE_QUEUE, async () => {
      await settleSnipes(ports);
    });
    await harness.schedule(WATCH_SNIPE_QUEUE, WATCH_SNIPE_CRON);
    await settleSnipes(ports);
  };
}
