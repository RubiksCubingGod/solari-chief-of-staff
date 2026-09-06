import { describe, expect, it } from 'vitest';

import { cancellationQuestion, reminderMessage } from './message.js';

/**
 * The words a reminder arrives as. One sentence, with everything a person needs
 * to act on it and nothing they would have to look up: which entry, what it is
 * about to do, on which day, how far off that is, and what it costs.
 */

const gym = { name: 'Gym', kind: 'subscription', date: '2026-09-12', amountCents: 4500 } as const;

describe('reminderMessage', () => {
  it('names the entry, its date, how far off it is, and what it costs', () => {
    expect(reminderMessage({ ...gym, today: '2026-09-09', late: false })).toBe(
      'Reminder: Gym renews on 2026-09-12 (in 3 days). Amount: 45.00.',
    );
  });

  it('says a deadline is due rather than renewing, and leaves out an amount it does not have', () => {
    expect(
      reminderMessage({
        name: 'Taxes',
        kind: 'deadline',
        date: '2026-10-01',
        amountCents: null,
        today: '2026-09-24',
        late: false,
      }),
    ).toBe('Reminder: Taxes is due by 2026-10-01 (in 7 days).');
  });

  it('says so when it is late, and counts the days left the way a person does', () => {
    expect(reminderMessage({ ...gym, today: '2026-09-10', late: true })).toBe(
      'Late reminder: Gym renews on 2026-09-12 (in 2 days). Amount: 45.00.',
    );
    expect(reminderMessage({ ...gym, today: '2026-09-11', late: true })).toBe(
      'Late reminder: Gym renews on 2026-09-12 (tomorrow). Amount: 45.00.',
    );
    expect(reminderMessage({ ...gym, today: '2026-09-12', late: true })).toBe(
      'Late reminder: Gym renews on 2026-09-12 (today). Amount: 45.00.',
    );
  });

  it('is honest about a date that has already gone by', () => {
    // The scan stops at the date, so this is the wording of a caller that
    // asked anyway; it should still be true rather than "in -1 days".
    expect(reminderMessage({ ...gym, today: '2026-09-13', late: true })).toBe(
      'Late reminder: Gym renews on 2026-09-12 (1 day ago). Amount: 45.00.',
    );
    expect(reminderMessage({ ...gym, today: '2026-09-15', late: true })).toBe(
      'Late reminder: Gym renews on 2026-09-12 (3 days ago). Amount: 45.00.',
    );
  });

  it('writes the amount the way the dashboard does: cents as a plain decimal, no currency guessed', () => {
    const on = { today: '2026-09-09', late: false } as const;
    expect(reminderMessage({ ...gym, ...on, amountCents: 2399 })).toContain('Amount: 23.99.');
    expect(reminderMessage({ ...gym, ...on, amountCents: 1000 })).toContain('Amount: 10.00.');
    expect(reminderMessage({ ...gym, ...on, amountCents: -2399 })).toContain('Amount: -23.99.');
    // Zero is an amount; only a missing one is left out.
    expect(reminderMessage({ ...gym, ...on, amountCents: 0 })).toContain('Amount: 0.00.');
    expect(reminderMessage({ ...gym, ...on, amountCents: undefined })).not.toContain('Amount');
  });
});

describe('cancellationQuestion', () => {
  it('names the entry, the renewal it is meant to beat, the stake, and the two replies it reads', () => {
    expect(cancellationQuestion({ name: 'Gym', renewOn: '2026-09-12', amountCents: 4500 })).toBe(
      'Cancel Gym before it renews on 2026-09-12? Amount: 45.00. Reply yes to go ahead, or no to leave it as it is.',
    );
  });

  it('leaves out an amount it does not have, and keeps a zero', () => {
    expect(cancellationQuestion({ name: 'Newsletter', renewOn: '2026-09-12' })).toBe(
      'Cancel Newsletter before it renews on 2026-09-12? Reply yes to go ahead, or no to leave it as it is.',
    );
    expect(
      cancellationQuestion({ name: 'Newsletter', renewOn: '2026-09-12', amountCents: null }),
    ).not.toContain('Amount');
    expect(cancellationQuestion({ name: 'Trial', renewOn: '2026-09-12', amountCents: 0 })).toContain(
      'Amount: 0.00.',
    );
  });
});
