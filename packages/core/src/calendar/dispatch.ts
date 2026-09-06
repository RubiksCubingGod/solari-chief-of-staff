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
 * What the auto-cancel arm decided for one renewal, and then how it ended.
 *
 * The arm writes `enqueued` when a cancellation task came of the renewal, or
 * `unlinked` when nothing can act on the entry - no site named, no playbook
 * for it, no connected site - and the entry is marked `needs_attention`
 * instead. An enqueued row is settled by a later scan once its task has
 * ended: `handled` when the cancellation went through, `declined` when the
 * person said no to it, `failed` when it ended any other way - unanswered,
 * refused by the site, broken. The row is the renewal's whole story, so the
 * dashboard can show it and the arm never asks twice about one renewal.
 */
export const CALENDAR_AUTO_CANCEL_STATES = [
  'enqueued',
  'unlinked',
  'handled',
  'declined',
  'failed',
] as const;
export type CalendarAutoCancelState = (typeof CALENDAR_AUTO_CANCEL_STATES)[number];

export const isCalendarReminderState = memberGuard(CALENDAR_REMINDER_STATES);
export const isCalendarAutoCancelState = memberGuard(CALENDAR_AUTO_CANCEL_STATES);
