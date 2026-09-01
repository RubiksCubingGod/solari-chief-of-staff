import type { CalendarItemKind, CalendarItemStatus } from '@chief-of-staff/core';

import type { ApiClient, CalendarItem } from '../api-client';
import { describeRefusal } from '../api-refusal';

/**
 * Everything the calendar page draws, worked out before any of it is drawn.
 *
 * The ordering is the reason this file exists. `GET /calendar-items` answers in
 * name order, which is the order a list of things is stored in and not the
 * order a calendar is read in: what a reader wants to know is what is coming
 * next. Turning one into the other is a decision with edges - a row with no
 * date at all, two rows on the same day - so it lives in a `.ts` module with
 * tests rather than inside the JSX, which is also the half of this package the
 * coverage gate measures.
 */

/** One calendar row as the page prints it: already dated, already labelled. */
export interface CalendarRow {
  readonly id: string;
  readonly name: string;
  readonly kind: CalendarItemKind;
  /**
   * The date this row is filed under, `YYYY-MM-DD`, or `undefined` for a row
   * that carries no date at all. Which column it came from depends on the kind,
   * and `dateLabel` is what says so.
   */
  readonly on: string | undefined;
  /** What the date means to a reader: a renewal, or a last chance to act. */
  readonly dateLabel: string;
  /** The amount as text, or `undefined` when the row carries none. */
  readonly amount: string | undefined;
  readonly status: CalendarItemStatus;
}

export interface CalendarView {
  readonly rows: readonly CalendarRow[];
  /** What went wrong, when the page has nothing to draw because of it. */
  readonly error: string | undefined;
}

export async function loadCalendarView(client: ApiClient): Promise<CalendarView> {
  let items: readonly CalendarItem[];
  try {
    items = await client.listCalendarItems();
  } catch (error: unknown) {
    return { rows: [], error: describeRefusal(error) };
  }

  return { rows: [...items].map(toRow).sort(byWhatHappensNext), error: undefined };
}

function toRow(item: CalendarItem): CalendarRow {
  // Each kind reads its own column, with no falling back to the other one. A
  // deadline whose `cancelBy` is empty is a deadline nobody dated, and showing
  // it under a renewal date it happens to carry would put a real date against
  // the wrong sentence - worse than saying plainly that there is none.
  const on = (item.kind === 'deadline' ? item.cancelBy : item.renewOn) ?? undefined;

  return {
    id: item.id,
    name: item.name,
    kind: item.kind,
    on,
    dateLabel: item.kind === 'deadline' ? 'Cancel by' : 'Renews',
    amount: renderAmount(item.amountCents),
    status: item.status,
  };
}

/**
 * Soonest first, undated last, and a total order either way.
 *
 * The last part matters as much as the first: a comparator that returned 0 for
 * two rows on the same day would leave their order to whatever the sort
 * happened to do, and a reload would be free to disagree with the render before
 * it. Name then id settles every pair, so the page a reader refreshes is the
 * page they were already looking at.
 */
function byWhatHappensNext(row: CalendarRow, other: CalendarRow): number {
  if (row.on !== other.on) {
    // Undated goes last rather than being dropped: a charge nobody has dated is
    // still a charge, and the dates are `YYYY-MM-DD`, which sorts as text.
    if (row.on === undefined) return 1;
    if (other.on === undefined) return -1;
    return row.on < other.on ? -1 : 1;
  }
  if (row.name !== other.name) return row.name < other.name ? -1 : 1;
  return row.id < other.id ? -1 : row.id > other.id ? 1 : 0;
}

/**
 * Integer cents as an amount, without ever becoming a float.
 *
 * `cents / 100` is a rounding decision taken by the hardware on money that
 * arrived exact, and two decimal places are kept even when they are zeroes:
 * "10" beside "23.99" reads as a different kind of number.
 */
function renderAmount(cents: number | null): string | undefined {
  // Not `0.00`, which would be this page inventing a price for something that
  // nobody priced.
  if (cents === null) return undefined;

  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  return `${sign}${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}
