import { CronExpressionParser } from 'cron-parser';

/**
 * The string shapes the routes accept, expressed as Ajv formats rather than
 * handler code. A value that fails one of these is refused by the same
 * validation pass as a missing field, so every refusal reaches the client as
 * one `validation_failed` envelope naming every bad field at once, and no
 * handler ever runs against a value it would have to re-check.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/**
 * A watch target has to be fetchable by the tier ladder in ARCHITECTURE §3.1,
 * which speaks HTTP. Anything else — `file:`, `javascript:`, a bare hostname —
 * is a request the watch engine could never serve.
 */
export function isHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'http:' || url.protocol === 'https:';
}

/**
 * Validated with the same parser pg-boss schedules on, so a cron expression the
 * API accepts is one the job harness can actually run. Rejecting it here rather
 * than at schedule time turns a silent dead watch into a 4xx the caller can fix.
 */
export function isCronExpression(value: string): boolean {
  // An empty expression parses as `* * * * *` - a watch that would hit the site
  // every minute. A schedule nobody wrote is a mistake, not a default.
  if (value.trim() === '') return false;
  try {
    CronExpressionParser.parse(value);
    return true;
  } catch {
    return false;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

/** A calendar date with no time or zone, matching the `date` columns in §5. */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;

/**
 * An instant, spelled the way `Date#toISOString` spells one. Observation
 * series are bounded against a `timestamptz`, so a bound written as a bare
 * calendar day would begin at a different moment for every caller; demanding
 * the zone makes the window the client asked for the window the database
 * compares against.
 *
 * It is not registered as `iso-date-time`, which would read better: Fastify
 * compiles schemas through ajv-formats, whose own `iso-date-time` makes the
 * zone optional and silently wins over a format of that name declared here.
 */
export function isIsoInstant(value: string): boolean {
  // The calendar part is held to the same rule a `date` column is, because
  // `Date` rolls the 30th of February forward into March rather than refusing
  // it, and a bound nobody wrote is worse than a bound that was refused.
  return ISO_INSTANT.test(value) && isIsoDate(value.slice(0, 10));
}

/**
 * The most observations one series request may return. A sparkline draws a few
 * hundred points at most, and without a ceiling one request could walk a
 * watch's entire history out of the database and into a browser.
 */
export const MAX_OBSERVATION_LIMIT = 500;

const POSITIVE_COUNT = /^[1-9]\d{0,4}$/u;

/**
 * Fastify hands query values to Ajv as strings and this server does not coerce
 * types, so the ceiling has to be checked against the string the client
 * actually sent. Checking it here rather than in the handler is what makes
 * `limit=5000` and `limit=lots` the same refusal naming the same field,
 * instead of one being a 400 and the other a quiet clamp nobody asked for.
 */
export function isObservationLimit(value: string): boolean {
  return POSITIVE_COUNT.test(value) && Number(value) <= MAX_OBSERVATION_LIMIT;
}

export const AJV_FORMATS: Readonly<Record<string, (value: string) => boolean>> = {
  'cron-expression': isCronExpression,
  'http-url': isHttpUrl,
  'iso-date': isIsoDate,
  'iso-instant': isIsoInstant,
  'observation-limit': isObservationLimit,
  uuid: isUuid,
};
