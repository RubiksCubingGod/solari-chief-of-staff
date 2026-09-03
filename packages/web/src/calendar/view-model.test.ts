import { describe, expect, it } from 'vitest';

import { ApiError, ApiUnreachableError, type CalendarItem } from '../api-client';
import { stubClient } from '../testing/stub-client';
import { loadCalendarView } from './view-model';

/**
 * What the calendar does with what it is handed, proven directly.
 *
 * The browser proves the page draws these rows; this proves the decisions
 * behind them, including the two the browser cannot provoke against a healthy
 * API - a refusal and an outage - and the ones a fixture would have to work
 * hard to arrange, like two items falling on the same day.
 */

function item(overrides: Partial<CalendarItem> & { readonly id: string }): CalendarItem {
  return {
    userId: 'user-1',
    kind: 'subscription',
    name: overrides.id,
    amountCents: null,
    renewOn: null,
    cancelBy: null,
    action: null,
    status: 'active',
    annotation: null,
    annotationNote: null,
    annotatedAt: null,
    ...overrides,
  };
}

describe('loadCalendarView', () => {
  it('files rows by their own date, soonest first, whatever order they arrive in', async () => {
    const view = await loadCalendarView(
      stubClient({
        listCalendarItems: () =>
          Promise.resolve([
            item({ id: 'december', renewOn: '2026-12-01' }),
            item({ id: 'march', kind: 'deadline', cancelBy: '2026-03-15' }),
            item({ id: 'june', renewOn: '2026-06-20' }),
          ]),
      }),
    );

    // The API answers in name order, which is a list and not a calendar. This
    // is the whole reason this module exists.
    expect(view.rows.map((row) => row.id)).toEqual(['march', 'june', 'december']);
    expect(view.error).toBeUndefined();
  });

  it('reads a deadline from its own column and says what the date means', async () => {
    const view = await loadCalendarView(
      stubClient({
        listCalendarItems: () =>
          Promise.resolve([
            item({ id: 'trial', kind: 'deadline', cancelBy: '2026-03-15' }),
            item({ id: 'plan', kind: 'subscription', renewOn: '2026-04-01' }),
          ]),
      }),
    );

    // Two kinds, two columns, two sentences. A page that read `renewOn` for
    // everything would show a deadline as undated, which is the one row a
    // reader most needs a date on.
    expect(view.rows[0]).toMatchObject({ id: 'trial', on: '2026-03-15', dateLabel: 'Cancel by' });
    expect(view.rows[1]).toMatchObject({ id: 'plan', on: '2026-04-01', dateLabel: 'Renews' });
  });

  it('keeps an undated row, and files it after everything that has a date', async () => {
    const view = await loadCalendarView(
      stubClient({
        listCalendarItems: () =>
          Promise.resolve([
            item({ id: 'undated' }),
            item({ id: 'dated', renewOn: '2026-05-01' }),
          ]),
      }),
    );

    // Dropped would be worse than last: a charge nobody has dated is the one
    // most worth seeing, and a calendar that hid it would be hiding the bill.
    expect(view.rows.map((row) => row.id)).toEqual(['dated', 'undated']);
    expect(view.rows[1]?.on).toBeUndefined();
  });

  it('orders two rows on the same day by name, so the page does not shuffle', async () => {
    const view = await loadCalendarView(
      stubClient({
        listCalendarItems: () =>
          Promise.resolve([
            item({ id: 'b', name: 'Beta', renewOn: '2026-05-01' }),
            item({ id: 'a', name: 'Alpha', renewOn: '2026-05-01' }),
          ]),
      }),
    );

    // A date is not a total order. Without a tiebreak, two rows on the same day
    // would come out in whichever order the sort happened to leave them, and a
    // reload would be free to disagree with the render before it.
    expect(view.rows.map((row) => row.id)).toEqual(['a', 'b']);
  });

  it('lands on the same order whichever order the API listed them in', async () => {
    const listed = [
      item({ id: 'i1', name: 'Beta', renewOn: '2026-05-01' }),
      item({ id: 'i2', name: 'Alpha', renewOn: '2026-05-01' }),
      item({ id: 'i3', name: 'Zulu' }),
      item({ id: 'i4', name: 'Aardvark' }),
    ];
    const expected = ['i2', 'i1', 'i4', 'i3'];

    const forwards = await loadCalendarView(
      stubClient({ listCalendarItems: () => Promise.resolve(listed) }),
    );
    const backwards = await loadCalendarView(
      stubClient({ listCalendarItems: () => Promise.resolve([...listed].reverse()) }),
    );

    // The same rows twice, arriving in opposite orders, coming out identical -
    // dated before undated, and each group by name. A comparator only has to be
    // wrong in one direction to sort correctly on the input a test happened to
    // pick, so both directions are the assertion.
    expect(forwards.rows.map((row) => row.id)).toEqual(expected);
    expect(backwards.rows.map((row) => row.id)).toEqual(expected);
  });

  it('separates two rows a reader could not tell apart', async () => {
    const view = await loadCalendarView(
      stubClient({
        listCalendarItems: () =>
          Promise.resolve([
            item({ id: 'b', name: 'Netflix', renewOn: '2026-05-01' }),
            item({ id: 'a', name: 'Netflix', renewOn: '2026-05-01' }),
          ]),
      }),
    );

    // Two charges with the same name on the same day is a real shape - the same
    // subscription billed on two cards - and it is the one pair a date and a
    // name cannot order. The id settles it, which is not a claim that the id
    // means anything, only that the page picks the same answer every time.
    expect(view.rows.map((row) => row.id)).toEqual(['a', 'b']);
  });

  it('prints integer cents as an amount, and nothing at all when none was recorded', async () => {
    const view = await loadCalendarView(
      stubClient({
        listCalendarItems: () =>
          Promise.resolve([
            item({ id: 'priced', amountCents: 2399, renewOn: '2026-01-01' }),
            item({ id: 'round', amountCents: 1000, renewOn: '2026-01-02' }),
            item({ id: 'free', renewOn: '2026-01-03' }),
          ]),
      }),
    );

    expect(view.rows[0]?.amount).toBe('23.99');
    // Two decimal places even when they are zeroes: money that renders as "10"
    // beside "23.99" reads as a different kind of number.
    expect(view.rows[1]?.amount).toBe('10.00');
    // Undefined rather than "0.00", which would be this page inventing a price
    // for something nobody priced.
    expect(view.rows[2]?.amount).toBeUndefined();
  });

  it('prints a credit as a credit rather than as arithmetic', async () => {
    const view = await loadCalendarView(
      stubClient({
        listCalendarItems: () =>
          Promise.resolve([item({ id: 'refund', amountCents: -2399, renewOn: '2026-01-01' })]),
      }),
    );

    // The schema stores a signed integer and nothing forbids a negative one, so
    // a refund can arrive here. It is worth an assertion because the obvious
    // way to split cents into two parts gets it visibly wrong: the whole part
    // and the remainder are both negative, and printing them in sequence gives
    // "-23.-99".
    expect(view.rows[0]?.amount).toBe('-23.99');
  });

  it('carries the mark an engine left on an entry, in the reader’s words, with its note', async () => {
    const note =
      'Auto-cancel could not be armed for the renewal on 2026-09-12: no connected site for gym.example.test.';
    const view = await loadCalendarView(
      stubClient({
        listCalendarItems: () =>
          Promise.resolve([
            item({
              id: 'attention',
              renewOn: '2026-09-12',
              annotation: 'needs_attention',
              annotationNote: note,
              annotatedAt: '2026-09-09T12:00:00.000Z',
            }),
            item({
              id: 'late',
              renewOn: '2026-09-13',
              annotation: 'late',
              annotationNote: 'The reminder for 2026-09-10 went out on 2026-09-11.',
              annotatedAt: '2026-09-11T09:00:00.000Z',
            }),
            item({
              id: 'declined',
              renewOn: '2026-09-14',
              annotation: 'declined',
              annotationNote: 'You said no to cancelling it before the renewal on 2026-09-14.',
              annotatedAt: '2026-09-11T10:00:00.000Z',
            }),
            item({
              id: 'handled',
              renewOn: '2026-09-15',
              annotation: 'handled',
              annotationNote: 'Cancelled on 2026-09-12, ahead of the renewal on 2026-09-15.',
              annotatedAt: '2026-09-12T09:00:00.000Z',
            }),
            item({ id: 'plain', renewOn: '2026-09-16' }),
          ]),
      }),
    );

    // Each mark in the words a reader would use for it, never the schema's,
    // with the engine's note beside it word for word: the note is the one
    // sentence that says what became of the entry and what to do about it.
    expect(view.rows.map((row) => [row.id, row.mark])).toEqual([
      ['attention', { label: 'Needs attention', note }],
      ['late', { label: 'Late reminder', note: 'The reminder for 2026-09-10 went out on 2026-09-11.' }],
      [
        'declined',
        {
          label: 'Auto-cancel declined',
          note: 'You said no to cancelling it before the renewal on 2026-09-14.',
        },
      ],
      ['handled', { label: 'Cancelled', note: 'Cancelled on 2026-09-12, ahead of the renewal on 2026-09-15.' }],
      ['plain', undefined],
    ]);
  });

  it('shows a mark whose note is missing rather than dropping the mark with it', async () => {
    const view = await loadCalendarView(
      stubClient({
        listCalendarItems: () => Promise.resolve([item({ id: 'bare', annotation: 'handled' })]),
      }),
    );

    expect(view.rows[0]?.mark).toEqual({ label: 'Cancelled', note: undefined });
  });

  it('turns a refusal into the page state, with the reason the API gave', async () => {
    const view = await loadCalendarView(
      stubClient({
        listCalendarItems: () =>
          Promise.reject(new ApiError(403, 'forbidden', 'this account may not read the calendar', [])),
      }),
    );

    expect(view.rows).toEqual([]);
    expect(view.error).toBe('this account may not read the calendar');
  });

  it('says the API did not answer when it did not answer', async () => {
    const view = await loadCalendarView(
      stubClient({
        listCalendarItems: () => Promise.reject(new ApiUnreachableError('https://api.example.com', new Error('ECONNREFUSED'))),
      }),
    );

    expect(view.rows).toEqual([]);
    expect(view.error).toBe('the API did not answer');
  });

  it('lets a defect in this process through rather than dressing it as a page state', async () => {
    // A page state is for what the server said. A `TypeError` here is a bug in
    // this file, and folding it into a banner would hide the stack that says
    // where it is.
    await expect(
      loadCalendarView(
        stubClient({ listCalendarItems: () => Promise.reject(new TypeError('not a function')) }),
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
