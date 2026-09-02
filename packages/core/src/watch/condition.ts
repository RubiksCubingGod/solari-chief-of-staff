import type { WatchKind } from '../index.js';

/**
 * What makes a watch worth telling somebody about, per kind.
 *
 * Stored as `jsonb` on the row exactly as the CRUD API accepted it, and parsed
 * here into a closed shape before a check reads it. The parse is strict in the
 * same way the extractor spec's is: a condition nobody can read is a watch
 * that never fires, silently, which is the product's worst failure mode.
 */

export interface PriceCondition {
  readonly kind: 'price';
  /** Fires when the price is strictly below this, in the page's own units. */
  readonly drops_below: number | null;
  /** Fires when the price is strictly above this. */
  readonly rises_above: number | null;
}

export interface ChangeCondition {
  readonly kind: 'change';
  /**
   * Where on the page to look, in the person's words ("the headline", "the
   * availability table"). Read at extractor creation, never at check time.
   */
  readonly region: string | null;
}

export type WatchCondition = PriceCondition | ChangeCondition;

const PRICE_KEYS: ReadonlySet<string> = new Set(['drops_below', 'rises_above']);
const CHANGE_KEYS: ReadonlySet<string> = new Set(['region']);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** An absent threshold, spelled either way, is null; anything but a finite number is a refusal. */
function threshold(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The condition a stored `condition` column holds for a watch of `kind`, or
 * `undefined` when it does not hold one: unknown keys, a threshold that is not
 * a finite number, a price watch with no threshold at all, or a kind this
 * sprint does not check.
 */
export function parseCondition(kind: WatchKind, value: unknown): WatchCondition | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const keys = Object.keys(record);

  switch (kind) {
    case 'price': {
      if (!keys.every((key) => PRICE_KEYS.has(key))) return undefined;
      const dropsBelow = threshold(record['drops_below']);
      const risesAbove = threshold(record['rises_above']);
      if (dropsBelow === undefined || risesAbove === undefined) return undefined;
      if (dropsBelow === null && risesAbove === null) return undefined;
      return { kind: 'price', drops_below: dropsBelow, rises_above: risesAbove };
    }
    case 'change': {
      if (!keys.every((key) => CHANGE_KEYS.has(key))) return undefined;
      const region = record['region'] ?? null;
      if (region !== null && (typeof region !== 'string' || region.trim() === '')) return undefined;
      return { kind: 'change', region };
    }
    case 'slot':
      return undefined;
  }
}

/** The condition in words, for a trigger message and for a log line. */
export function describeCondition(condition: WatchCondition): string {
  if (condition.kind === 'change') {
    return condition.region === null ? 'the page changes' : `${condition.region} changes`;
  }
  const clauses: string[] = [];
  if (condition.drops_below !== null) clauses.push(`drops below ${String(condition.drops_below)}`);
  if (condition.rises_above !== null) clauses.push(`rises above ${String(condition.rises_above)}`);
  return `the price ${clauses.join(' or ')}`;
}
