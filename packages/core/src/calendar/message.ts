import type { CalendarItemKind } from '../index.js';

import { daysBetween, type IsoDate } from './dates.js';

/**
 * The words the calendar speaks in.
 *
 * A reminder is one sentence with everything a person needs to act and
 * nothing they would have to look up: which entry, what it is about to do, on
 * which day, how far off that is, and what it costs. The confirm gate's
 * question says the same about a cancellation, and then spells out the two
 * replies it reads. Pure, so the scan's proofs can say exactly what went on
 * the wire without a database in the room.
 */

export interface ReminderMessageInput {
  readonly name: string;
  readonly kind: CalendarItemKind;
  /** The renewal or the cancel-by, whichever the kind is scanned by. */
  readonly date: IsoDate;
  readonly today: IsoDate;
  /** Left out of the message when absent; zero is an amount. */
  readonly amountCents?: number | null | undefined;
  /** Whether the lead day has already gone by, so the message should say so. */
  readonly late: boolean;
}

export function reminderMessage(input: ReminderMessageInput): string {
  const lead = input.late ? 'Late reminder' : 'Reminder';
  const verb = input.kind === 'subscription' ? 'renews on' : 'is due by';
  const distance = describeDistance(daysBetween(input.today, input.date));
  return `${lead}: ${input.name} ${verb} ${input.date} (${distance}).${amountClause(input.amountCents)}`;
}

export interface CancellationQuestionInput {
  readonly name: string;
  readonly renewOn: IsoDate;
  /** Left out of the question when absent; zero is an amount. */
  readonly amountCents?: number | null | undefined;
}

/**
 * The confirm gate's question, as a cancel task carries it in its input and
 * as the person sees it. It names the entry and the renewal it is meant to
 * beat, says what is at stake, and tells the person the two words the gate
 * reads - the reply comes back through a chat as words, and the words they
 * are told to use are the ones `readConsent` knows.
 */
export function cancellationQuestion(input: CancellationQuestionInput): string {
  const stake = amountClause(input.amountCents);
  return `Cancel ${input.name} before it renews on ${input.renewOn}?${stake} Reply yes to go ahead, or no to leave it as it is.`;
}

/** The amount as its own sentence, or nothing when there is none. */
function amountClause(amountCents: number | null | undefined): string {
  return amountCents === undefined || amountCents === null
    ? ''
    : ` Amount: ${formatAmount(amountCents)}.`;
}

function describeDistance(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days > 1) return `in ${String(days)} days`;
  return `${plural(-days, 'day')} ago`;
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/** Cents as a plain decimal, the way the dashboard shows them: the schema does not say which currency. */
function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}
