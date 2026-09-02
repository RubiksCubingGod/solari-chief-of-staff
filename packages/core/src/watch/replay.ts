import { load } from 'cheerio';

import type { ExtractorSpec } from './extractor.js';
import { digestText, parsePrice, type WatchValue } from './value.js';

/**
 * The deterministic half of the extractor lifecycle (specs/extractor-lifecycle.md).
 *
 * A stored spec is replayed against a page on every check, with no model in
 * the room: the same spec and the same page give the same value, and the
 * marginal cost of a check is zero tokens. What lives here is that replay, the
 * reasons it can fail - each one distinct, because the healing step and the
 * person reading `last_error` both need to know whether the selector broke,
 * the value vanished, or the text stopped looking like a price - and the
 * snapshot reducer that decides what the model is shown when a spec has to be
 * made or remade.
 */

export const REPLAY_FAILURES = ['invalid-selector', 'no-match', 'empty', 'unparseable'] as const;
export type ReplayFailure = (typeof REPLAY_FAILURES)[number];

export type ReplayResult =
  | {
      readonly ok: true;
      readonly value: WatchValue;
      /** How many elements the selector matched; a price reads the first. */
      readonly matched: number;
      /** The text the value was read from, whitespace collapsed. */
      readonly text: string;
    }
  | { readonly ok: false; readonly failure: ReplayFailure; readonly reason: string };

const REASON_EXCERPT_CHARS = 80;

export function replayExtractor(spec: ExtractorSpec, html: string): ReplayResult {
  const $ = load(html);

  let matches: ReturnType<typeof $>;
  try {
    matches = $(spec.selector);
  } catch (error: unknown) {
    return {
      ok: false,
      failure: 'invalid-selector',
      reason: `${spec.selector} is not a selector the replay engine can parse: ${messageOf(error)}`,
    };
  }
  if (matches.length === 0) {
    return { ok: false, failure: 'no-match', reason: `nothing on the page matches ${spec.selector}` };
  }

  // A price is one number; a list of prices is not a price, so the first
  // match is the value. A digest is of a region, which may be several
  // elements, and all of them count.
  const scope = spec.parse === 'price' ? matches.first() : matches;
  const text = scope
    .toArray()
    .map((element) => (spec.attribute === null ? $(element).text() : ($(element).attr(spec.attribute) ?? '')))
    .map((piece) => piece.replace(/\s+/gu, ' ').trim())
    .filter((piece) => piece !== '')
    .join(' ');

  if (text === '') {
    const what = spec.attribute === null ? 'text' : `${spec.attribute} attribute`;
    return { ok: false, failure: 'empty', reason: `${spec.selector} matched, but the match has no ${what}` };
  }

  if (spec.parse === 'price') {
    const value = parsePrice(text);
    if (value === undefined) {
      return { ok: false, failure: 'unparseable', reason: `no price in "${excerpt(text)}"` };
    }
    return { ok: true, value, matched: matches.length, text };
  }
  return { ok: true, value: digestText(text), matched: matches.length, text };
}

export function describeReplayFailure(result: ReplayResult & { readonly ok: false }): string {
  return `${result.failure}: ${result.reason}`;
}

/**
 * Enough of a page for a model to choose a selector from, and no more. A
 * product page's markup is a few thousand tokens; its scripts, styles and
 * tracking payloads are often ten times that and say nothing about where the
 * price is. Sixty thousand characters is roughly fifteen thousand tokens.
 */
export const DEFAULT_SNAPSHOT_CHARS = 60_000;

const TRUNCATION_MARK = '…[truncated]';

/**
 * The page with everything a selector cannot target removed: scripts, styles,
 * noscript fallbacks, templates, inline SVG, comments and inline event
 * handlers, and whitespace collapsed to single spaces. What remains is the
 * element tree with its attributes and text - which is exactly the surface a
 * CSS selector addresses.
 */
export function pageSnapshot(html: string, maxChars: number = DEFAULT_SNAPSHOT_CHARS): string {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/giu, '')
    .replace(/\s+on[a-z]+="[^"]*"/giu, '')
    .replace(/\s+on[a-z]+='[^']*'/giu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars)}${TRUNCATION_MARK}`;
}

function excerpt(text: string): string {
  return text.length <= REASON_EXCERPT_CHARS ? text : `${text.slice(0, REASON_EXCERPT_CHARS)}…`;
}

/** The selector parser throws plain Errors; the class name adds nothing to the reason. */
function messageOf(error: unknown): string {
  return String(error).replace(/^Error: /u, '');
}
