import { CronExpressionParser, type CronExpression } from 'cron-parser';

import { isTierPolicy, type WatchKind } from '../index.js';
import { parseExtractorSpec, parserForKind } from './extractor.js';

/**
 * The door a watch configuration comes through.
 *
 * JSON Schema at the API settles the shape of a request; this settles its
 * meaning, in the engine's own terms: a threshold the comparator could act
 * on, a schedule above the frequency floor, an extractor that reads the kind
 * of value this watch is about. The rule is that what the door accepts, the
 * check path can read back (`parseCondition`, `parseExtractorSpec`,
 * `tiersToTry`) - a watch that was stored and never fired would be the
 * product's quietest failure. Every violation names its field as a JSON
 * Pointer, so a form can be fixed in one round trip.
 */

/** ARCHITECTURE §10: a watch is checked at most every five minutes. */
export const SCHEDULE_FLOOR_MS = 5 * 60_000;

/** A schedule that comes due later than this is a watch nobody will hear from. */
export const SCHEDULE_HORIZON_MS = 366 * 24 * 60 * 60_000;

/** A region hint is a phrase for the model, not a page. */
export const MAX_REGION_CHARS = 200;

/**
 * How many consecutive runs are measured for the shortest gap. The shortest
 * gap in a cron pattern recurs within its innermost cycle, which for the
 * patterns a person writes is an hour or a day, and every-five-minutes for
 * five hundred runs is under two days.
 */
const SCHEDULE_SAMPLE_RUNS = 500;

export type ScheduleVerdict =
  | {
      readonly ok: true;
      readonly nextAt: Date;
      /** Between consecutive runs; null when only one run falls inside the horizon. */
      readonly shortestGapMs: number | null;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Whether a cron expression is a schedule the engine will honour: one that
 * parses, runs no more often than the floor, and comes due within the
 * horizon. The clock is a parameter so the verdict is reproducible.
 */
export function checkSchedule(cron: string, now: Date = new Date()): ScheduleVerdict {
  // An empty expression parses as `* * * * *`; a schedule nobody wrote is a
  // mistake, not a default.
  if (cron.trim() === '') return { ok: false, reason: 'is not a cron expression' };

  let expression: CronExpression;
  try {
    // Evaluated in UTC, which is what the job harness schedules in; a floor
    // and a horizon read the same in any zone, and the verdict must not
    // depend on the machine the door happens to run on.
    expression = CronExpressionParser.parse(cron, { currentDate: now, tz: 'UTC' });
  } catch {
    return { ok: false, reason: 'is not a cron expression' };
  }

  const runs: number[] = [];
  const horizon = now.getTime() + SCHEDULE_HORIZON_MS;
  try {
    while (runs.length < SCHEDULE_SAMPLE_RUNS) {
      const at = expression.next().getTime();
      if (at > horizon) break;
      runs.push(at);
    }
  } catch {
    // cron-parser gives up on a day and month that never meet (the 31st of
    // April): an expression with no run at all is one that never comes due.
  }

  const [first] = runs;
  if (first === undefined) return { ok: false, reason: 'never comes due within a year' };

  let shortestGapMs: number | null = null;
  let previous = first;
  for (const at of runs.slice(1)) {
    const gap = at - previous;
    if (shortestGapMs === null || gap < shortestGapMs) shortestGapMs = gap;
    previous = at;
  }
  if (shortestGapMs !== null && shortestGapMs < SCHEDULE_FLOOR_MS) {
    return {
      ok: false,
      reason: `runs every ${describeInterval(shortestGapMs)}; the floor is every ${describeInterval(SCHEDULE_FLOOR_MS)}`,
    };
  }
  return { ok: true, nextAt: new Date(first), shortestGapMs };
}

/**
 * Why a URL is not one the tier ladder should fetch, or `undefined` when it
 * is. Credentials are refused because the URL is copied into `last_error`,
 * observations and logs, none of which should hold a password.
 */
export function checkWatchUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'is not a URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'has to use http or https';
  if (parsed.username !== '' || parsed.password !== '') return 'must not carry credentials';
  return undefined;
}

export interface ConfigViolation {
  /** A JSON Pointer into the configuration: `/schedule`, `/condition/drops_below`. */
  readonly path: string;
  readonly message: string;
}

export interface WatchConfigInput {
  readonly kind: WatchKind;
  readonly url: string;
  readonly schedule: string;
  readonly condition: unknown;
  /** Absent or `{}` means the model writes one on the first check. */
  readonly extractor?: unknown;
  readonly tierPolicy?: string | undefined;
}

/**
 * Every way this configuration is not one the engine can check, or an empty
 * list. A kind the engine has no parser for is reported on its own: there is
 * no sense in which its condition or extractor could be right.
 */
export function watchConfigViolations(input: WatchConfigInput, now: Date = new Date()): ConfigViolation[] {
  const violations: ConfigViolation[] = [];

  const parser = parserForKind(input.kind);
  if (parser === undefined) {
    violations.push({ path: '/kind', message: `${input.kind} watches are not checked by this engine yet` });
  }

  const urlProblem = checkWatchUrl(input.url);
  if (urlProblem !== undefined) violations.push({ path: '/url', message: urlProblem });

  const schedule = checkSchedule(input.schedule, now);
  if (!schedule.ok) violations.push({ path: '/schedule', message: schedule.reason });

  if (parser !== undefined) {
    violations.push(...conditionViolations(input.kind, input.condition));
    violations.push(...extractorViolations(input.kind, parser, input.extractor));
  }

  if (input.tierPolicy !== undefined && !isTierPolicy(input.tierPolicy)) {
    violations.push({ path: '/tierPolicy', message: 'is not a tier policy' });
  }

  return violations;
}

const PRICE_KEYS: ReadonlySet<string> = new Set(['drops_below', 'rises_above']);
const CHANGE_KEYS: ReadonlySet<string> = new Set(['region']);

function conditionViolations(kind: WatchKind, condition: unknown): ConfigViolation[] {
  if (typeof condition !== 'object' || condition === null || Array.isArray(condition)) {
    return [{ path: '/condition', message: 'has to be an object' }];
  }
  const record = condition as Record<string, unknown>;
  const known = kind === 'price' ? PRICE_KEYS : CHANGE_KEYS;
  const violations: ConfigViolation[] = Object.keys(record)
    .filter((key) => !known.has(key))
    .map((key) => ({ path: `/condition/${key}`, message: `is not a setting a ${kind} watch has` }));

  if (kind === 'price') {
    const dropsBelow = record['drops_below'] ?? null;
    const risesAbove = record['rises_above'] ?? null;
    if (dropsBelow !== null && !isThreshold(dropsBelow)) {
      violations.push({ path: '/condition/drops_below', message: 'has to be a number of zero or more' });
    } else if (dropsBelow === 0) {
      // Nothing is priced below zero, so this threshold could never fire.
      violations.push({ path: '/condition/drops_below', message: 'has to be above zero' });
    }
    if (risesAbove !== null && !isThreshold(risesAbove)) {
      violations.push({ path: '/condition/rises_above', message: 'has to be a number of zero or more' });
    }
    if (dropsBelow === null && risesAbove === null) {
      violations.push({ path: '/condition', message: 'needs drops_below or rises_above' });
    } else if (isThreshold(dropsBelow) && isThreshold(risesAbove) && dropsBelow >= risesAbove) {
      violations.push({ path: '/condition', message: 'drops_below has to be below rises_above' });
    }
    return violations;
  }

  const region = record['region'] ?? null;
  if (region !== null) {
    if (typeof region !== 'string') {
      violations.push({ path: '/condition/region', message: 'has to be text' });
    } else if (region.trim() === '') {
      violations.push({ path: '/condition/region', message: 'has to say where to look' });
    } else if (region.length > MAX_REGION_CHARS) {
      violations.push({
        path: '/condition/region',
        message: `has to be at most ${String(MAX_REGION_CHARS)} characters`,
      });
    }
  }
  return violations;
}

function extractorViolations(kind: WatchKind, parser: string, extractor: unknown): ConfigViolation[] {
  if (extractor === undefined || isEmptyRecord(extractor)) return [];
  const spec = parseExtractorSpec(extractor);
  if (spec === undefined) return [{ path: '/extractor', message: 'is not an extractor spec' }];
  if (spec.parse !== parser) {
    return [{ path: '/extractor/parse', message: `a ${kind} watch reads with a ${parser} extractor` }];
  }
  return [];
}

function isThreshold(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isEmptyRecord(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}

function describeInterval(ms: number): string {
  if (ms < 60_000) return plural(Math.round(ms / 1000), 'second');
  return plural(Math.round(ms / 60_000), 'minute');
}

function plural(count: number, unit: string): string {
  return `${String(count)} ${unit}${count === 1 ? '' : 's'}`;
}
