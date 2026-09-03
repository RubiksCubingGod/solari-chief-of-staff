import { describe, expect, it } from 'vitest';

import {
  CALENDAR_AUTO_CANCEL_STATES,
  CALENDAR_REMINDER_STATES,
  isCalendarAutoCancelState,
  isCalendarReminderState,
} from './dispatch.js';

/**
 * The states a recorded dispatch can be in. A reminder row is written before
 * the send (`pending`) and settled after it; an auto-cancel row is written when
 * the arm decides, says whether a task came of it, and is settled by how that
 * task ended.
 */

describe('the dispatch vocabularies', () => {
  it('start a reminder as pending and end it in one of the four ways the spec names', () => {
    expect(CALENDAR_REMINDER_STATES).toEqual(['pending', 'delivered', 'late', 'failed', 'skipped_unbound']);
  });

  it('record an auto-cancel as a task enqueued or an entry nobody can act on, then how it ended', () => {
    expect(CALENDAR_AUTO_CANCEL_STATES).toEqual([
      'enqueued',
      'unlinked',
      'handled',
      'declined',
      'failed',
    ]);
  });

  it('guard their members', () => {
    expect(isCalendarReminderState('late')).toBe(true);
    expect(isCalendarReminderState('sent')).toBe(false);
    expect(isCalendarAutoCancelState('unlinked')).toBe(true);
    expect(isCalendarAutoCancelState('handled')).toBe(true);
    expect(isCalendarAutoCancelState('pending')).toBe(false);
  });
});
