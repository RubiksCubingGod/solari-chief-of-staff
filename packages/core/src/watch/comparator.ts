import { createHash } from 'node:crypto';

import type { PriceCondition, WatchCondition } from './condition.js';
import { type PriceValue, type WatchValue, valueIdentity } from './value.js';

/**
 * Step 3 of a check (ARCHITECTURE §3.1): the new value against the last one.
 *
 * The rule from the sprint README is that a trigger fires on a threshold
 * crossing or a content change and never fires again on the same value. Both
 * halves are here, and nowhere else: the notifier is told only about
 * comparisons that triggered, and the dedup key it is handed is derived from
 * the same three things the comparison read, so a retried job says the same
 * thing twice rather than two different things once.
 */

export interface Comparison {
  readonly triggered: boolean;
  /** In words, for the observation and for the person: why, or why not. */
  readonly reason: string;
}

/** Whether a price is on the far side of the condition's threshold(s). */
export function priceSatisfies(condition: PriceCondition, value: PriceValue): boolean {
  const below = condition.drops_below !== null && value.amount < condition.drops_below;
  const above = condition.rises_above !== null && value.amount > condition.rises_above;
  return below || above;
}

function crossingWords(condition: PriceCondition, value: PriceValue): string {
  if (condition.drops_below !== null && value.amount < condition.drops_below) {
    return `drops below ${String(condition.drops_below)}`;
  }
  return `rises above ${String(condition.rises_above)}`;
}

function comparePrice(
  condition: PriceCondition,
  previous: WatchValue | null,
  current: WatchValue,
): Comparison {
  if (current.kind !== 'price') {
    return { triggered: false, reason: `the extracted value is a ${current.kind}, not a price` };
  }
  const now = priceSatisfies(condition, current);
  // A previous value of another kind is no previous price at all: the watch
  // starts over, as it does on its first observation.
  const before = previous?.kind === 'price' && priceSatisfies(condition, previous);
  const amount = String(current.amount);
  if (!now) {
    const bounds = [
      condition.drops_below === null ? [] : [`drop below ${String(condition.drops_below)}`],
      condition.rises_above === null ? [] : [`rise above ${String(condition.rises_above)}`],
    ].flat();
    return { triggered: false, reason: `price ${amount} does not ${bounds.join(' or ')}` };
  }
  const crossing = crossingWords(condition, current);
  // Already on the far side last time: the person was told then. "Still" is
  // the README's never-re-firing-on-the-same-value, and it also covers a
  // different value on the same side, which is not a new crossing.
  return before
    ? { triggered: false, reason: `price ${amount} still ${crossing}` }
    : { triggered: true, reason: `price ${amount} ${crossing}` };
}

function compareChange(previous: WatchValue | null, current: WatchValue): Comparison {
  if (current.kind !== 'digest') {
    return { triggered: false, reason: `the extracted value is a ${current.kind}, not a digest` };
  }
  if (previous?.kind !== 'digest') {
    // Nothing to have changed from. The first reading of a change watch is
    // the baseline, and a previous value of another kind starts one over.
    return { triggered: false, reason: 'baseline recorded' };
  }
  return previous.digest === current.digest
    ? { triggered: false, reason: 'content unchanged' }
    : { triggered: true, reason: 'content changed' };
}

export function compare(
  condition: WatchCondition,
  previous: WatchValue | null,
  current: WatchValue,
): Comparison {
  return condition.kind === 'price'
    ? comparePrice(condition, previous, current)
    : compareChange(previous, current);
}

/**
 * The key a trigger is deduplicated by: (watch, condition, value), canonically
 * spelled and hashed. Two emissions with the same key are one trigger
 * delivered twice - which is what a job retried after a crash produces, and
 * what the notifier port's consumers must treat as one.
 */
export function triggerDedupKey(
  watchId: string,
  condition: WatchCondition,
  value: WatchValue,
): string {
  const canonical = JSON.stringify([watchId, sortKeys(condition), sortKeys(valueIdentity(value))]);
  return createHash('sha256').update(canonical).digest('hex');
}

function sortKeys(record: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => (left < right ? -1 : 1)),
  );
}
