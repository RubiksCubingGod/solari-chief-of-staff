import type { CalendarItemKind } from '../index.js';

import { daysBetween, type IsoDate } from './dates.js';

/**
 * The words a reminder arrives as.
 *
 * One sentence with everything a person needs to act and nothing they would
 * have to look up: which entry, what it is about to do, on which day, how far
 * off that is, and what it costs. Pure, so the scan's proofs can say exactly
 * what went on the wire without a database in the room.
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
  const amount =
    input.amountCents === undefined || input.amountCents === null
      ? ''
      : ` Amount: ${formatAmount(input.amountCents)}.`;
  return `${lead}: ${input.name} ${verb} ${input.date} (${distance}).${amount}`;
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
