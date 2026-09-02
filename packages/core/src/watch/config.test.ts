import { describe, expect, it } from 'vitest';

import { parseCondition } from './condition.js';
import {
  MAX_REGION_CHARS,
  SCHEDULE_FLOOR_MS,
  SCHEDULE_HORIZON_MS,
  checkSchedule,
  checkWatchUrl,
  watchConfigViolations,
  type WatchConfigInput,
} from './config.js';
import { parseExtractorSpec } from './extractor.js';

/**
 * The door a watch configuration comes through. What it accepts, the check
 * path can run; what it refuses, it refuses by field, in words a person can
 * act on. The clock is fixed so a schedule's verdict does not depend on the
 * day the suite runs.
 */

const NOW = new Date('2026-09-02T00:00:00Z');

describe('checkSchedule', () => {
  it('fixes the floor at five minutes and the horizon at a year', () => {
    expect(SCHEDULE_FLOOR_MS).toBe(300_000);
    expect(SCHEDULE_HORIZON_MS).toBe(366 * 86_400_000);
  });

  it('accepts a schedule at or above the floor and says when it next comes due', () => {
    expect(checkSchedule('*/15 * * * *', NOW)).toEqual({
      ok: true,
      nextAt: new Date('2026-09-02T00:15:00Z'),
      shortestGapMs: 900_000,
    });
    expect(checkSchedule('*/5 * * * *', NOW)).toMatchObject({ ok: true, shortestGapMs: 300_000 });
    expect(checkSchedule('0 9 * * 1-5', NOW)).toMatchObject({ ok: true, shortestGapMs: 86_400_000 });
  });

  it('refuses a schedule under the floor, naming the interval it would run at', () => {
    expect(checkSchedule('* * * * *', NOW)).toEqual({
      ok: false,
      reason: 'runs every 1 minute; the floor is every 5 minutes',
    });
    // The shortest gap counts, not the average: 0 and 3 past the hour is a
    // three-minute gap once an hour.
    expect(checkSchedule('0,3 * * * *', NOW)).toEqual({
      ok: false,
      reason: 'runs every 3 minutes; the floor is every 5 minutes',
    });
    expect(checkSchedule('*/30 * * * * *', NOW)).toEqual({
      ok: false,
      reason: 'runs every 30 seconds; the floor is every 5 minutes',
    });
  });

  it('accepts a schedule that fires once within the horizon, and refuses one that never does', () => {
    // Once a year, next on 2027-01-01: one fire inside the horizon, so there
    // is no gap to measure and nothing to refuse.
    expect(checkSchedule('0 0 1 1 *', NOW)).toEqual({
      ok: true,
      nextAt: new Date('2027-01-01T00:00:00Z'),
      shortestGapMs: null,
    });
    // The next 29th of February after 2026-09-02 is in 2028.
    expect(checkSchedule('0 0 29 2 *', NOW)).toEqual({ ok: false, reason: 'never comes due within a year' });
    // The 31st of April and of June do not exist; cron-parser accepts the
    // expression and then gives up looking.
    expect(checkSchedule('0 0 31 4,6 *', NOW)).toEqual({ ok: false, reason: 'never comes due within a year' });
  });

  it('refuses prose and an empty expression, which would otherwise mean every minute', () => {
    expect(checkSchedule('every other friday', NOW)).toEqual({ ok: false, reason: 'is not a cron expression' });
    expect(checkSchedule('', NOW)).toEqual({ ok: false, reason: 'is not a cron expression' });
    expect(checkSchedule('   ', NOW)).toEqual({ ok: false, reason: 'is not a cron expression' });
  });
});

describe('checkWatchUrl', () => {
  it('accepts what the tier ladder can fetch, fixtures on localhost included', () => {
    expect(checkWatchUrl('https://shop.test/product/widget?ref=1')).toBeUndefined();
    expect(checkWatchUrl('http://127.0.0.1:8080/product/widget')).toBeUndefined();
  });

  it('refuses a scheme no tier speaks, a string that is not a url, and embedded credentials', () => {
    expect(checkWatchUrl('ftp://shop.test/x')).toBe('has to use http or https');
    expect(checkWatchUrl('shop.test/product/widget')).toBe('is not a URL');
    expect(checkWatchUrl('https://user:hunter2@shop.test/x')).toBe('must not carry credentials');
    expect(checkWatchUrl('https://user@shop.test/x')).toBe('must not carry credentials');
  });
});

const PRICE_WATCH: WatchConfigInput = {
  kind: 'price',
  url: 'https://shop.test/product/widget',
  schedule: '*/15 * * * *',
  condition: { drops_below: 15 },
};

const CHANGE_WATCH: WatchConfigInput = {
  kind: 'change',
  url: 'https://news.test/story/1',
  schedule: '0 * * * *',
  condition: { region: 'the headline' },
};

const DIGEST_SPEC = { version: 1, strategy: 'css', selector: 'h1', attribute: null, parse: 'digest' };

function paths(input: WatchConfigInput): string[] {
  return watchConfigViolations(input, NOW)
    .map((violation) => violation.path)
    .sort();
}

describe('watchConfigViolations', () => {
  it('has nothing to say about a watch the engine can run', () => {
    expect(watchConfigViolations(PRICE_WATCH, NOW)).toEqual([]);
    expect(watchConfigViolations({ ...PRICE_WATCH, condition: { rises_above: 0 } }, NOW)).toEqual([]);
    expect(
      watchConfigViolations({ ...PRICE_WATCH, condition: { drops_below: 15, rises_above: 20 } }, NOW),
    ).toEqual([]);
    expect(watchConfigViolations(CHANGE_WATCH, NOW)).toEqual([]);
    expect(watchConfigViolations({ ...CHANGE_WATCH, condition: {} }, NOW)).toEqual([]);
    expect(watchConfigViolations({ ...CHANGE_WATCH, condition: { region: null } }, NOW)).toEqual([]);
    // An empty extractor is "let the model write one"; a full one is kept as given.
    expect(watchConfigViolations({ ...CHANGE_WATCH, extractor: {} }, NOW)).toEqual([]);
    expect(watchConfigViolations({ ...CHANGE_WATCH, extractor: DIGEST_SPEC, tierPolicy: 'browser' }, NOW)).toEqual([]);
  });

  it('accepts only what the check path can read back', () => {
    const accepted: WatchConfigInput[] = [
      PRICE_WATCH,
      { ...PRICE_WATCH, condition: { drops_below: 15, rises_above: 20 } },
      CHANGE_WATCH,
      { ...CHANGE_WATCH, condition: {}, extractor: DIGEST_SPEC },
    ];
    for (const input of accepted) {
      expect(watchConfigViolations(input, NOW)).toEqual([]);
      expect(parseCondition(input.kind, input.condition)).toBeDefined();
      if (input.extractor !== undefined) expect(parseExtractorSpec(input.extractor)).toBeDefined();
    }
  });

  it('refuses a kind the engine has no parser for, without judging the rest', () => {
    expect(watchConfigViolations({ ...PRICE_WATCH, kind: 'slot', condition: { anything: true } }, NOW)).toEqual([
      { path: '/kind', message: 'slot watches are not checked by this engine yet' },
    ]);
  });

  it('refuses the url, the schedule and the tier policy by field', () => {
    expect(watchConfigViolations({ ...PRICE_WATCH, url: 'https://user:hunter2@shop.test/x' }, NOW)).toEqual([
      { path: '/url', message: 'must not carry credentials' },
    ]);
    expect(watchConfigViolations({ ...PRICE_WATCH, schedule: '*/2 * * * *' }, NOW)).toEqual([
      { path: '/schedule', message: 'runs every 2 minutes; the floor is every 5 minutes' },
    ]);
    expect(watchConfigViolations({ ...PRICE_WATCH, tierPolicy: 'warp' }, NOW)).toEqual([
      { path: '/tierPolicy', message: 'is not a tier policy' },
    ]);
  });

  it('refuses a price condition the comparator could not act on', () => {
    expect(watchConfigViolations({ ...PRICE_WATCH, condition: 'cheap' }, NOW)).toEqual([
      { path: '/condition', message: 'has to be an object' },
    ]);
    expect(watchConfigViolations({ ...PRICE_WATCH, condition: {} }, NOW)).toEqual([
      { path: '/condition', message: 'needs drops_below or rises_above' },
    ]);
    expect(watchConfigViolations({ ...PRICE_WATCH, condition: { drops_below: null, rises_above: null } }, NOW)).toEqual([
      { path: '/condition', message: 'needs drops_below or rises_above' },
    ]);
    expect(watchConfigViolations({ ...PRICE_WATCH, condition: { drops_below: 'cheap' } }, NOW)).toEqual([
      { path: '/condition/drops_below', message: 'has to be a number of zero or more' },
    ]);
    expect(watchConfigViolations({ ...PRICE_WATCH, condition: { rises_above: -1 } }, NOW)).toEqual([
      { path: '/condition/rises_above', message: 'has to be a number of zero or more' },
    ]);
    expect(watchConfigViolations({ ...PRICE_WATCH, condition: { drops_below: Infinity } }, NOW)).toEqual([
      { path: '/condition/drops_below', message: 'has to be a number of zero or more' },
    ]);
    // Nothing is priced below zero, so this threshold could never fire.
    expect(watchConfigViolations({ ...PRICE_WATCH, condition: { drops_below: 0 } }, NOW)).toEqual([
      { path: '/condition/drops_below', message: 'has to be above zero' },
    ]);
    expect(watchConfigViolations({ ...PRICE_WATCH, condition: { drops_below: 30, rises_above: 20 } }, NOW)).toEqual([
      { path: '/condition', message: 'drops_below has to be below rises_above' },
    ]);
    expect(watchConfigViolations({ ...PRICE_WATCH, condition: { drops_below: 20, rises_above: 20 } }, NOW)).toEqual([
      { path: '/condition', message: 'drops_below has to be below rises_above' },
    ]);
    expect(watchConfigViolations({ ...PRICE_WATCH, condition: { drops_below: 15, colour: 'red' } }, NOW)).toEqual([
      { path: '/condition/colour', message: 'is not a setting a price watch has' },
    ]);
  });

  it('refuses a change region that says nothing, too much, or is not text', () => {
    expect(watchConfigViolations({ ...CHANGE_WATCH, condition: { region: '   ' } }, NOW)).toEqual([
      { path: '/condition/region', message: 'has to say where to look' },
    ]);
    expect(watchConfigViolations({ ...CHANGE_WATCH, condition: { region: 7 } }, NOW)).toEqual([
      { path: '/condition/region', message: 'has to be text' },
    ]);
    expect(watchConfigViolations({ ...CHANGE_WATCH, condition: { region: 'x'.repeat(MAX_REGION_CHARS + 1) } }, NOW)).toEqual(
      [{ path: '/condition/region', message: `has to be at most ${String(MAX_REGION_CHARS)} characters` }],
    );
    expect(watchConfigViolations({ ...CHANGE_WATCH, condition: { region: 'x'.repeat(MAX_REGION_CHARS) } }, NOW)).toEqual(
      [],
    );
    expect(watchConfigViolations({ ...CHANGE_WATCH, condition: { drops_below: 15 } }, NOW)).toEqual([
      { path: '/condition/drops_below', message: 'is not a setting a change watch has' },
    ]);
  });

  it('refuses an extractor that is not a spec, or reads the wrong kind of value', () => {
    expect(watchConfigViolations({ ...PRICE_WATCH, extractor: { selector: '.price' } }, NOW)).toEqual([
      { path: '/extractor', message: 'is not an extractor spec' },
    ]);
    expect(watchConfigViolations({ ...PRICE_WATCH, extractor: DIGEST_SPEC }, NOW)).toEqual([
      { path: '/extractor/parse', message: 'a price watch reads with a price extractor' },
    ]);
    expect(watchConfigViolations({ ...CHANGE_WATCH, extractor: { ...DIGEST_SPEC, parse: 'price' } }, NOW)).toEqual([
      { path: '/extractor/parse', message: 'a change watch reads with a digest extractor' },
    ]);
  });

  it('reports every violation at once, in field order', () => {
    expect(
      paths({
        kind: 'price',
        url: 'shop.test/x',
        schedule: '* * * * *',
        condition: { drops_below: 30, rises_above: 20, colour: 'red' },
        extractor: { selector: '.p' },
        tierPolicy: 'warp',
      }),
    ).toEqual(['/condition', '/condition/colour', '/extractor', '/schedule', '/tierPolicy', '/url']);
  });
});
