/**
 * Calendar days as the `YYYY-MM-DD` strings Postgres `date` columns carry.
 *
 * The arithmetic is done on the day, never on an instant: a `Date` has a time
 * zone, and "three days before the 1st" must come out as the 29th on every
 * machine, not the 28th at 23:00 on one west of Greenwich. The one place an
 * instant is turned into a day (`calendarDayIn`) says whose clock it reads.
 */

/** A calendar day, `YYYY-MM-DD`, that exists. */
export type IsoDate = string;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const MS_PER_DAY = 86_400_000;

/** True for a `YYYY-MM-DD` string that names a real day; `2026-02-30` is not one. */
export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string') return false;
  const match = ISO_DATE.exec(value);
  if (match === null) return false;
  const [, year, month, day] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return formatUtcDay(parsed) === value;
}

/** Days since the epoch at UTC midnight - an integer, so day arithmetic is integer arithmetic. */
function epochDay(date: IsoDate): number {
  if (!isIsoDate(date)) throw new Error(`'${String(date)}' is not a calendar day`);
  return Date.parse(`${date}T00:00:00Z`) / MS_PER_DAY;
}

function formatUtcDay(instant: Date): IsoDate {
  return instant.toISOString().slice(0, 10);
}

/** The day `days` after `date`; negative moves backwards. Crosses months, years and leap days. */
export function addDays(date: IsoDate, days: number): IsoDate {
  return formatUtcDay(new Date((epochDay(date) + days) * MS_PER_DAY));
}

/** How many days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return epochDay(to) - epochDay(from);
}

/**
 * The calendar day it is at `instant` on a clock in `timeZone`. This is the
 * "today" a scan runs against for a person: the reminder for the 12th goes on
 * their 9th, not the server's.
 */
export function calendarDayIn(instant: Date, timeZone: string): IsoDate {
  // `en-CA` is the locale whose short date is already `YYYY-MM-DD`.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}
