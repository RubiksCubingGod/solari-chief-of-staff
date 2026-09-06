import { createHash } from 'node:crypto';

import type { PriceCondition, WatchCondition } from './condition.js';
import { type PriceValue, type SlotListing, type WatchValue, valueIdentity } from './value.js';

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
  /** For a slot watch that triggered: the slot to book, the first one the last observation did not list. */
  readonly slot?: SlotListing;
}

/**
 * Which of the condition's bounds a price is past. Both at once only when the
 * parser let a floor sit above its ceiling; the floor's words win then.
 */
interface Sides {
  readonly below: boolean;
  readonly above: boolean;
}

const NEITHER: Sides = { below: false, above: false };

function sidesOf(condition: PriceCondition, value: PriceValue): Sides {
  return {
    below: condition.drops_below !== null && value.amount < condition.drops_below,
    above: condition.rises_above !== null && value.amount > condition.rises_above,
  };
}

/** Whether a price is on the far side of the condition's threshold(s). */
export function priceSatisfies(condition: PriceCondition, value: PriceValue): boolean {
  const sides = sidesOf(condition, value);
  return sides.below || sides.above;
}

function crossingWords(condition: PriceCondition, sides: Sides): string {
  return sides.below
    ? `drops below ${String(condition.drops_below)}`
    : `rises above ${String(condition.rises_above)}`;
}

function comparePrice(
  condition: PriceCondition,
  previous: WatchValue | null,
  current: WatchValue,
): Comparison {
  if (current.kind !== 'price') {
    return { triggered: false, reason: `the extracted value is a ${current.kind}, not a price` };
  }
  const now = sidesOf(condition, current);
  // A previous value of another kind is no previous price at all: the watch
  // starts over, as it does on its first observation.
  const before = previous?.kind === 'price' ? sidesOf(condition, previous) : NEITHER;
  const amount = String(current.amount);
  if (!now.below && !now.above) {
    const bounds = [
      condition.drops_below === null ? [] : [`drop below ${String(condition.drops_below)}`],
      condition.rises_above === null ? [] : [`rise above ${String(condition.rises_above)}`],
    ].flat();
    return { triggered: false, reason: `price ${amount} does not ${bounds.join(' or ')}` };
  }
  const crossing = crossingWords(condition, now);
  // Each bound is its own crossing: a price past a bound it was not past last
  // time is news, even when last time it was past the other one. Already past
  // this bound last time, the person was told then. "Still" is the README's
  // never-re-firing-on-the-same-value, and it also covers a different value on
  // the same side, which is not a new crossing.
  const crossed = (now.below && !before.below) || (now.above && !before.above);
  return crossed
    ? { triggered: true, reason: `price ${amount} ${crossing}` }
    : { triggered: false, reason: `price ${amount} still ${crossing}` };
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

/**
 * A slot watch fires on a slot that was not listed last time. The same
 * listing twice is one slot, however long it stays open, which is what keeps
 * a declined slot from being offered again on every check; a slot that went
 * and came back is listed again against a baseline without it, and is news.
 * First listed wins: the README's "first matching slot", with no ranking.
 */
function compareSlots(previous: WatchValue | null, current: WatchValue): Comparison {
  if (current.kind !== 'slots') {
    return { triggered: false, reason: `the extracted value is a ${current.kind}, not a slot list` };
  }
  if (current.slots.length === 0) return { triggered: false, reason: 'no slots available' };
  const listed = new Set(previous?.kind === 'slots' ? previous.slots.map((slot) => slot.id) : []);
  const fresh = current.slots.find((slot) => !listed.has(slot.id));
  return fresh === undefined
    ? { triggered: false, reason: 'no slot that was not listed last time' }
    : { triggered: true, reason: `slot ${fresh.label} appeared`, slot: fresh };
}

export function compare(
  condition: WatchCondition,
  previous: WatchValue | null,
  current: WatchValue,
): Comparison {
  switch (condition.kind) {
    case 'price':
      return comparePrice(condition, previous, current);
    case 'change':
      return compareChange(previous, current);
    case 'slot':
      return compareSlots(previous, current);
  }
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
