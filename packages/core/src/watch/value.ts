import { createHash } from 'node:crypto';

/**
 * What a check extracts from a page, in the three shapes the engine knows.
 *
 * A value is what gets compared, persisted as the observation's `value` and the
 * watch's `last_value`, and shown to a person in a trigger. It is plain JSON
 * with no optional keys, so a value read back from `jsonb` is byte-for-byte
 * the value that was written and equality is not a question of spelling.
 */

export const WATCH_VALUE_KINDS = ['price', 'digest', 'slots'] as const;
export type WatchValueKind = (typeof WATCH_VALUE_KINDS)[number];

export interface PriceValue {
  readonly kind: 'price';
  /** In the page's own major units: 14.99, never 1499. */
  readonly amount: number;
  /** ISO 4217 when the page said, or null when it only printed a number. */
  readonly currency: string | null;
  /** The text the amount was read from, kept so a wrong parse can be seen. */
  readonly raw: string;
}

export interface DigestValue {
  readonly kind: 'digest';
  /** SHA-256, hex, of the normalized text of the watched region. */
  readonly digest: string;
  /** The first line or so of that text, for the person reading a trigger. */
  readonly excerpt: string;
}

/** One appointment a calendar lists as bookable. */
export interface SlotListing {
  /**
   * What makes this the same slot next time: an attribute the extractor read,
   * or the label itself when the page has nothing steadier. Two listings with
   * one id are one slot, however the page renders them.
   */
  readonly id: string;
  /** The slot as the page prints it, for the person and for the booking arm. */
  readonly label: string;
}

/**
 * Every slot a calendar offers right now, in page order. An empty list is a
 * value, not a failure: a calendar with nothing open is the steady state a
 * slot watch spends most of its life reading.
 */
export interface SlotsValue {
  readonly kind: 'slots';
  readonly slots: readonly SlotListing[];
}

export type WatchValue = PriceValue | DigestValue | SlotsValue;

/** The symbols a page is likely to print instead of a currency code. */
const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
};

const CURRENCY_CODE = /\b(USD|EUR|GBP|JPY|CAD|AUD|CHF|INR|CNY)\b/u;
const NUMBER = /\d(?:[\d.,\s]*\d)?/u;

/**
 * Reads a price out of the text a selector matched.
 *
 * Deliberately a heuristic and deliberately small: it handles the shapes a
 * shop prints ("$19.99", "1.299,00 €", "£1,299", "USD 45") and refuses text
 * with no digits at all. When both separators appear the last one is the
 * decimal point; a lone separator followed by exactly three digits is read as
 * a thousands separator, because "1,299" is a price and "1,29" is not one a
 * shop prints.
 */
export function parsePrice(text: string): PriceValue | undefined {
  const match = NUMBER.exec(text);
  if (match === null) return undefined;

  const digits = match[0].replace(/\s/gu, '');
  const lastComma = digits.lastIndexOf(',');
  const lastDot = digits.lastIndexOf('.');
  let integerPart = digits;
  let fraction = '';
  if (lastComma !== -1 || lastDot !== -1) {
    const separator = lastComma > lastDot ? ',' : '.';
    const position = Math.max(lastComma, lastDot);
    const tail = digits.slice(position + 1);
    const soleSeparatorAsThousands =
      digits.indexOf(separator) === position && tail.length === 3 && !digits.includes(separator === ',' ? '.' : ',');
    if (!soleSeparatorAsThousands) {
      integerPart = digits.slice(0, position);
      fraction = tail;
    }
  }
  const normalized = `${integerPart.replace(/[.,]/gu, '')}${fraction === '' ? '' : `.${fraction}`}`;
  // Always finite: the match is digits and separators, and the separators
  // have just been resolved into at most one decimal point.
  const amount = Number(normalized);
  return { kind: 'price', amount, currency: currencyOf(text), raw: text.trim() };
}

function currencyOf(text: string): string | null {
  const code = CURRENCY_CODE.exec(text)?.[1];
  if (code !== undefined) return code;
  for (const [symbol, currency] of Object.entries(CURRENCY_SYMBOLS)) {
    if (text.includes(symbol)) return currency;
  }
  return null;
}

/** How much of the watched text a trigger shows. */
export const EXCERPT_LENGTH = 160;

/**
 * Whitespace is not content. A page that re-indents its markup, or one whose
 * server wraps lines differently on Tuesdays, has not changed.
 */
export function normalizeText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

export function digestText(text: string): DigestValue {
  const normalized = normalizeText(text);
  return {
    kind: 'digest',
    digest: createHash('sha256').update(normalized).digest('hex'),
    excerpt: normalized.slice(0, EXCERPT_LENGTH),
  };
}

export function isWatchValue(value: unknown): value is WatchValue {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record['kind'] === 'price') {
    return (
      typeof record['amount'] === 'number' &&
      Number.isFinite(record['amount']) &&
      (record['currency'] === null || typeof record['currency'] === 'string') &&
      typeof record['raw'] === 'string'
    );
  }
  if (record['kind'] === 'digest') {
    return typeof record['digest'] === 'string' && typeof record['excerpt'] === 'string';
  }
  if (record['kind'] === 'slots') {
    return Array.isArray(record['slots']) && record['slots'].every(isSlotListing);
  }
  return false;
}

export function isSlotListing(value: unknown): value is SlotListing {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['id'] === 'string' && typeof record['label'] === 'string';
}

/**
 * The part of a value that makes it the same value again. The raw text and the
 * excerpt are for people; two readings of "$14.99" and "14.99 USD" are one
 * price, and dedup has to say so.
 */
export function valueIdentity(value: WatchValue): Record<string, unknown> {
  switch (value.kind) {
    case 'price':
      return { kind: 'price', amount: value.amount, currency: value.currency };
    case 'digest':
      return { kind: 'digest', digest: value.digest };
    case 'slots':
      return { kind: 'slots', ids: value.slots.map((slot) => slot.id) };
  }
}

export function sameValue(left: WatchValue, right: WatchValue): boolean {
  return JSON.stringify(valueIdentity(left)) === JSON.stringify(valueIdentity(right));
}
