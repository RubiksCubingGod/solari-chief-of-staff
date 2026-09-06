import { describe, expect, it } from 'vitest';

import {
  autoCancelDue,
  autoCancelKey,
  dueEntries,
  entryDate,
  reminderDue,
  reminderKey,
  type CalendarEntry,
} from './entry.js';

/**
 * Due computation: the one function both arms of the daily scan consume. A
 * reminder is owed from the lead day until the date itself and is late on any
 * day but the first; an auto-cancel is owed from its own threshold until the
 * renewal. Everything else is the entry saying no: done, handled, unflagged,
 * undated, or the wrong kind.
 */

function entry(overrides: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    id: 'gym',
    kind: 'subscription',
    renewOn: '2026-09-12',
    cancelBy: null,
    status: 'active',
    reminderLeadDays: 3,
    autoCancel: false,
    autoCancelLeadDays: 3,
    annotation: null,
    ...overrides,
  };
}

const deadline = (overrides: Partial<CalendarEntry> = {}): CalendarEntry =>
  entry({ id: 'taxes', kind: 'deadline', renewOn: null, cancelBy: '2026-10-01', ...overrides });

describe('entryDate', () => {
  it('is the renewal for a subscription and the cancel-by for a deadline', () => {
    expect(entryDate(entry())).toBe('2026-09-12');
    expect(entryDate(deadline())).toBe('2026-10-01');
  });

  it('reads only the date its kind is scanned by', () => {
    expect(entryDate(entry({ cancelBy: '2026-09-01' }))).toBe('2026-09-12');
    expect(entryDate(deadline({ renewOn: '2026-09-01' }))).toBe('2026-10-01');
    expect(entryDate(entry({ renewOn: null, cancelBy: '2026-09-01' }))).toBeUndefined();
    expect(entryDate(deadline({ cancelBy: null, renewOn: '2026-09-01' }))).toBeUndefined();
  });
});

describe('reminderDue', () => {
  it('is owed on the lead day before a subscription renews', () => {
    expect(reminderDue(entry(), '2026-09-09')).toEqual({
      entryId: 'gym',
      dueOn: '2026-09-09',
      late: false,
      key: 'reminder:gym:2026-09-09',
    });
  });

  it('is owed on the lead day before a deadline', () => {
    expect(reminderDue(deadline({ reminderLeadDays: 7 }), '2026-09-24')).toEqual({
      entryId: 'taxes',
      dueOn: '2026-09-24',
      late: false,
      key: 'reminder:taxes:2026-09-24',
    });
  });

  it('is not owed before the lead day', () => {
    expect(reminderDue(entry(), '2026-09-08')).toBeUndefined();
  });

  it('is owed late on every day after the lead day, up to and including the date', () => {
    expect(reminderDue(entry(), '2026-09-10')).toMatchObject({ dueOn: '2026-09-09', late: true });
    expect(reminderDue(entry(), '2026-09-12')).toMatchObject({ dueOn: '2026-09-09', late: true });
  });

  it('is no longer owed once the date has passed', () => {
    expect(reminderDue(entry(), '2026-09-13')).toBeUndefined();
  });

  it('with no lead is owed on the date itself, and on time', () => {
    expect(reminderDue(entry({ reminderLeadDays: 0 }), '2026-09-11')).toBeUndefined();
    expect(reminderDue(entry({ reminderLeadDays: 0 }), '2026-09-12')).toMatchObject({
      dueOn: '2026-09-12',
      late: false,
    });
  });

  it('counts the lead across a year boundary', () => {
    expect(reminderDue(entry({ renewOn: '2027-01-01' }), '2026-12-29')).toMatchObject({
      dueOn: '2026-12-29',
      late: false,
    });
    expect(reminderDue(entry({ renewOn: '2027-01-01' }), '2026-12-28')).toBeUndefined();
  });

  it('is never owed by a done entry or a handled one', () => {
    expect(reminderDue(entry({ status: 'done' }), '2026-09-09')).toBeUndefined();
    expect(reminderDue(entry({ annotation: 'handled' }), '2026-09-09')).toBeUndefined();
  });

  it('is still owed by an entry whose auto-cancel was declined or needs attention', () => {
    // Saying no to the cancellation is not saying no to being reminded.
    expect(reminderDue(entry({ annotation: 'declined' }), '2026-09-09')).toBeDefined();
    expect(reminderDue(entry({ annotation: 'needs_attention' }), '2026-09-09')).toBeDefined();
    expect(reminderDue(entry({ annotation: 'late' }), '2026-09-09')).toBeDefined();
  });

  it('is never owed by an entry without the date its kind is scanned by', () => {
    expect(reminderDue(entry({ renewOn: null }), '2026-09-09')).toBeUndefined();
    expect(reminderDue(deadline({ cancelBy: null }), '2026-09-24')).toBeUndefined();
  });

  it('refuses a lead that is not a whole number of days', () => {
    expect(() => reminderDue(entry({ reminderLeadDays: -1 }), '2026-09-09')).toThrow(
      'reminderLeadDays must be a whole number of days, got -1',
    );
    expect(() => reminderDue(entry({ reminderLeadDays: 1.5 }), '2026-09-09')).toThrow(
      'reminderLeadDays must be a whole number of days, got 1.5',
    );
  });

  it('refuses a today that is not a calendar day', () => {
    // String comparison is how the window is decided, so a malformed day
    // would not be wrong loudly; it would be wrong quietly.
    expect(() => reminderDue(entry(), '2026-9-9')).toThrow("'2026-9-9' is not a calendar day");
    expect(() => autoCancelDue(entry({ autoCancel: true }), '09/09/2026')).toThrow(
      "'09/09/2026' is not a calendar day",
    );
  });
});

describe('autoCancelDue', () => {
  const flagged = (overrides: Partial<CalendarEntry> = {}): CalendarEntry =>
    entry({ autoCancel: true, ...overrides });

  it('is owed from the threshold day until the renewal, keyed by the renewal', () => {
    expect(autoCancelDue(flagged(), '2026-09-08')).toBeUndefined();
    expect(autoCancelDue(flagged(), '2026-09-09')).toEqual({
      entryId: 'gym',
      renewOn: '2026-09-12',
      key: 'auto-cancel:gym:2026-09-12',
    });
    expect(autoCancelDue(flagged(), '2026-09-12')).toMatchObject({ renewOn: '2026-09-12' });
    expect(autoCancelDue(flagged(), '2026-09-13')).toBeUndefined();
  });

  it('has its own lead, independent of the reminder’s', () => {
    const both = flagged({ reminderLeadDays: 7, autoCancelLeadDays: 1 });

    expect(reminderDue(both, '2026-09-04')).toBeUndefined();
    expect(autoCancelDue(both, '2026-09-04')).toBeUndefined();
    expect(reminderDue(both, '2026-09-05')).toMatchObject({ late: false });
    expect(autoCancelDue(both, '2026-09-05')).toBeUndefined();
    expect(reminderDue(both, '2026-09-10')).toMatchObject({ late: true });
    expect(autoCancelDue(both, '2026-09-10')).toBeUndefined();
    expect(reminderDue(both, '2026-09-11')).toMatchObject({ late: true });
    expect(autoCancelDue(both, '2026-09-11')).toMatchObject({ renewOn: '2026-09-12' });
  });

  it('is never owed by an unflagged subscription', () => {
    expect(autoCancelDue(entry(), '2026-09-09')).toBeUndefined();
  });

  it('is never owed by a deadline, flagged or not', () => {
    expect(autoCancelDue(deadline({ autoCancel: true, autoCancelLeadDays: 7 }), '2026-09-24')).toBeUndefined();
  });

  it('is never owed once the entry is handled or the person has declined', () => {
    expect(autoCancelDue(flagged({ annotation: 'handled' }), '2026-09-09')).toBeUndefined();
    expect(autoCancelDue(flagged({ annotation: 'declined' }), '2026-09-09')).toBeUndefined();
    // Needing attention is a reason to try again, not a reason to stop.
    expect(autoCancelDue(flagged({ annotation: 'needs_attention' }), '2026-09-09')).toBeDefined();
  });

  it('is never owed by a done entry or one without a renewal date', () => {
    expect(autoCancelDue(flagged({ status: 'done' }), '2026-09-09')).toBeUndefined();
    expect(autoCancelDue(flagged({ renewOn: null }), '2026-09-09')).toBeUndefined();
  });

  it('refuses a lead that is not a whole number of days', () => {
    expect(() => autoCancelDue(flagged({ autoCancelLeadDays: -2 }), '2026-09-09')).toThrow(
      'autoCancelLeadDays must be a whole number of days, got -2',
    );
  });
});

describe('dueEntries', () => {
  it('splits what is owed today into the two arms, in entry order', () => {
    const entries = [
      entry({ id: 'early', renewOn: '2026-09-30' }),
      entry({ id: 'both', autoCancel: true }),
      deadline({ id: 'late-deadline', cancelBy: '2026-09-10', reminderLeadDays: 3 }),
      entry({ id: 'done', status: 'done' }),
    ];

    expect(dueEntries(entries, '2026-09-09')).toEqual({
      reminders: [
        { entryId: 'both', dueOn: '2026-09-09', late: false, key: 'reminder:both:2026-09-09' },
        {
          entryId: 'late-deadline',
          dueOn: '2026-09-07',
          late: true,
          key: 'reminder:late-deadline:2026-09-07',
        },
      ],
      autoCancels: [{ entryId: 'both', renewOn: '2026-09-12', key: 'auto-cancel:both:2026-09-12' }],
    });
  });

  it('is empty on a quiet day', () => {
    expect(dueEntries([entry()], '2026-08-01')).toEqual({ reminders: [], autoCancels: [] });
  });
});

describe('the idempotence keys', () => {
  it('name the arm, so a reminder and an auto-cancel on the same day cannot collide', () => {
    expect(reminderKey('gym', '2026-09-12')).toBe('reminder:gym:2026-09-12');
    expect(autoCancelKey('gym', '2026-09-12')).toBe('auto-cancel:gym:2026-09-12');
    expect(reminderKey('gym', '2026-09-12')).not.toBe(autoCancelKey('gym', '2026-09-12'));
  });
});
