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

/** Who the booking is for. What a site's form asks, and no more than a slot watch needs. */
export interface SlotApplicant {
  readonly name: string;
}

export interface SlotCondition {
  readonly kind: 'slot';
  /** The site a booking playbook is registered for: `fakedmv`. */
  readonly site: string;
  readonly applicant: SlotApplicant;
  /**
   * Book without asking. Off by default: the booking arm asks the person
   * before it submits, per the s5 consequence posture.
   */
  readonly auto_book: boolean;
}

export type WatchCondition = PriceCondition | ChangeCondition | SlotCondition;

const PRICE_KEYS: ReadonlySet<string> = new Set(['drops_below', 'rises_above']);
const CHANGE_KEYS: ReadonlySet<string> = new Set(['region']);
const SLOT_KEYS: ReadonlySet<string> = new Set(['site', 'applicant', 'auto_book']);
const APPLICANT_KEYS: ReadonlySet<string> = new Set(['name']);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A name for a form: text with something in it. */
function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** The applicant a slot condition holds, or `undefined` when it holds anything else. */
export function parseApplicant(value: unknown): SlotApplicant | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  if (!Object.keys(record).every((key) => APPLICANT_KEYS.has(key))) return undefined;
  const name = record['name'];
  return nonBlank(name) ? { name: name.trim() } : undefined;
}

/** An absent threshold, spelled either way, is null; anything but a finite number is a refusal. */
function threshold(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The condition a stored `condition` column holds for a watch of `kind`, or
 * `undefined` when it does not hold one: unknown keys, a threshold that is not
 * a finite number, a price watch with no threshold at all, a slot watch with
 * no site or no applicant.
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
    case 'slot': {
      if (!keys.every((key) => SLOT_KEYS.has(key))) return undefined;
      const site = record['site'];
      const applicant = parseApplicant(record['applicant']);
      const autoBook = record['auto_book'] ?? false;
      if (!nonBlank(site) || applicant === undefined || typeof autoBook !== 'boolean') return undefined;
      return { kind: 'slot', site: site.trim(), applicant, auto_book: autoBook };
    }
  }
}

/** The condition in words, for a trigger message and for a log line. */
export function describeCondition(condition: WatchCondition): string {
  if (condition.kind === 'change') {
    return condition.region === null ? 'the page changes' : `${condition.region} changes`;
  }
  if (condition.kind === 'slot') {
    return `an appointment slot appears on ${condition.site}`;
  }
  const clauses: string[] = [];
  if (condition.drops_below !== null) clauses.push(`drops below ${String(condition.drops_below)}`);
  if (condition.rises_above !== null) clauses.push(`rises above ${String(condition.rises_above)}`);
  return `the price ${clauses.join(' or ')}`;
}
