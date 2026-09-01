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

export const AJV_FORMATS: Readonly<Record<string, (value: string) => boolean>> = {
  'cron-expression': isCronExpression,
  'http-url': isHttpUrl,
  'iso-date': isIsoDate,
  uuid: isUuid,
};
