import { memberGuard } from '../vocabulary.js';

/**
 * What a recorded dispatch can be in.
 *
 * A reminder row is written `pending` before the send is attempted, so a
 * process that dies mid-send leaves a row saying a reminder was owed; the scan
 * then settles it. `late` is a delivery on a day after the one it was owed.
 * `skipped_unbound` is a person with no chat to send to: recorded, so the
 * scan does not try again every day, and visible, so somebody can bind them.
 */
export const CALENDAR_REMINDER_STATES = [
  'pending',
  'delivered',
  'late',
  'failed',
  'skipped_unbound',
] as const;
export type CalendarReminderState = (typeof CALENDAR_REMINDER_STATES)[number];

/**
 * What the auto-cancel arm decided for one renewal: a cancellation task was
 * enqueued, or the entry is `unlinked` - no connected site or no playbook for
 * it - and the entry was marked `needs_attention` instead.
 */
export const CALENDAR_AUTO_CANCEL_STATES = ['enqueued', 'unlinked'] as const;
export type CalendarAutoCancelState = (typeof CALENDAR_AUTO_CANCEL_STATES)[number];

export const isCalendarReminderState = memberGuard(CALENDAR_REMINDER_STATES);
export const isCalendarAutoCancelState = memberGuard(CALENDAR_AUTO_CANCEL_STATES);
