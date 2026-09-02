import { describe, expect, it } from 'vitest';

import { addDays, calendarDayIn, daysBetween, hourIn, isIsoDate } from './dates.js';

/**
 * Calendar arithmetic on the `YYYY-MM-DD` strings Postgres `date` columns
 * carry. Done on the string rather than through `Date`, because a `Date` is an
 * instant and an instant has a time zone, and "three days before the 1st" must
 * not become "the 28th at 23:00 the day before" on a machine west of Greenwich.
 */

describe('isIsoDate', () => {
  it('accepts a real calendar day', () => {
    expect(isIsoDate('2026-09-02')).toBe(true);
    expect(isIsoDate('2024-02-29')).toBe(true);
  });

  it('rejects a day that does not exist, however well it is spelled', () => {
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2025-02-29')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
  });

  it('rejects anything that is not four-two-two', () => {
    expect(isIsoDate('2026-9-2')).toBe(false);
    expect(isIsoDate('2026-09-02T00:00:00Z')).toBe(false);
    expect(isIsoDate('')).toBe(false);
    expect(isIsoDate(20260902)).toBe(false);
    expect(isIsoDate(null)).toBe(false);
  });
});

describe('addDays', () => {
  it('moves within a month', () => {
    expect(addDays('2026-09-10', 3)).toBe('2026-09-13');
    expect(addDays('2026-09-10', -3)).toBe('2026-09-07');
  });

  it('crosses a month, a year, and a leap day', () => {
    expect(addDays('2026-01-01', -3)).toBe('2025-12-29');
    expect(addDays('2026-02-27', 3)).toBe('2026-03-02');
    expect(addDays('2024-02-27', 3)).toBe('2024-03-01');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
  });

  it('is the identity for zero', () => {
    expect(addDays('2026-09-02', 0)).toBe('2026-09-02');
  });

  it('refuses a day that is not a day', () => {
    expect(() => addDays('2026-02-30', 1)).toThrow("'2026-02-30' is not a calendar day");
  });
});

describe('daysBetween', () => {
  it('counts forward as positive and backward as negative', () => {
    expect(daysBetween('2026-09-02', '2026-09-05')).toBe(3);
    expect(daysBetween('2026-09-05', '2026-09-02')).toBe(-3);
    expect(daysBetween('2026-09-02', '2026-09-02')).toBe(0);
  });

  it('counts across a year boundary and a leap year', () => {
    expect(daysBetween('2025-12-29', '2026-01-01')).toBe(3);
    expect(daysBetween('2024-01-01', '2025-01-01')).toBe(366);
  });

  it('refuses a day that is not a day', () => {
    expect(() => daysBetween('2026-09-02', 'tomorrow')).toThrow("'tomorrow' is not a calendar day");
  });
});

describe('calendarDayIn', () => {
  // 23:30 UTC on the 2nd: already the 3rd in Tokyo, still the 2nd in London,
  // and still the 2nd in New York.
  const instant = new Date('2026-09-02T23:30:00Z');

  it('is the day on the person’s wall clock, not the server’s', () => {
    expect(calendarDayIn(instant, 'Asia/Tokyo')).toBe('2026-09-03');
    expect(calendarDayIn(instant, 'Europe/London')).toBe('2026-09-03');
    expect(calendarDayIn(instant, 'America/New_York')).toBe('2026-09-02');
    expect(calendarDayIn(instant, 'UTC')).toBe('2026-09-02');
  });

  it('refuses a zone it cannot place', () => {
    expect(() => calendarDayIn(instant, 'Mars/Olympus_Mons')).toThrow(RangeError);
  });
});

describe('hourIn', () => {
  const instant = new Date('2026-09-02T23:30:00Z');

  it('is the hour on the person’s wall clock, 0 to 23', () => {
    expect(hourIn(instant, 'Asia/Tokyo')).toBe(8);
    expect(hourIn(instant, 'Europe/London')).toBe(0);
    expect(hourIn(instant, 'America/New_York')).toBe(19);
    expect(hourIn(instant, 'UTC')).toBe(23);
  });

  it('counts a half-hour zone by its hour', () => {
    // 23:30 UTC is 05:00 in Kolkata: on the hour there, so no rounding question.
    expect(hourIn(instant, 'Asia/Kolkata')).toBe(5);
    expect(hourIn(new Date('2026-09-02T04:00:00Z'), 'Asia/Kolkata')).toBe(9);
  });

  it('refuses a zone it cannot place', () => {
    expect(() => hourIn(instant, 'Mars/Olympus_Mons')).toThrow(RangeError);
  });
});
