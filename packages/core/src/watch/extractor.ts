import { type WatchKind, memberGuard } from '../index.js';

/**
 * The extractor spec stored on a watch row (extractor-lifecycle spec).
 *
 * Created once by the model, then replayed on every check without it. The
 * schema is deliberately closed: a spec is a value the engine executes against
 * a live page, so an unknown key or a loose type here is not "forward
 * compatible", it is an extractor that does something nobody reviewed.
 */

export const EXTRACTOR_SPEC_VERSION = 1;

/** How the spec finds its element. One strategy so far; s8 adds what slots need. */
export const EXTRACTOR_STRATEGIES = ['css'] as const;
export type ExtractorStrategy = (typeof EXTRACTOR_STRATEGIES)[number];

/** How the matched text becomes a value. Each parser produces one value kind. */
export const EXTRACTOR_PARSERS = ['price', 'digest'] as const;
export type ExtractorParser = (typeof EXTRACTOR_PARSERS)[number];

export interface ExtractorSpec {
  readonly version: typeof EXTRACTOR_SPEC_VERSION;
  readonly strategy: ExtractorStrategy;
  /** A CSS selector. The first match is the element read. */
  readonly selector: string;
  /** Read this attribute of the match instead of its text content. */
  readonly attribute: string | null;
  readonly parse: ExtractorParser;
}

export const isExtractorStrategy = memberGuard(EXTRACTOR_STRATEGIES);
export const isExtractorParser = memberGuard(EXTRACTOR_PARSERS);

const SPEC_KEYS: ReadonlySet<string> = new Set(['version', 'strategy', 'selector', 'attribute', 'parse']);

/**
 * The spec a stored `extractor` column holds, or `undefined` when it holds
 * anything else - including the `{}` a watch is created with before the model
 * has written one, which is what "needs an extractor" looks like in the row.
 */
export function parseExtractorSpec(value: unknown): ExtractorSpec | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!Object.keys(record).every((key) => SPEC_KEYS.has(key))) return undefined;
  const { version, strategy, selector, attribute, parse } = record;
  if (version !== EXTRACTOR_SPEC_VERSION) return undefined;
  if (!isExtractorStrategy(strategy) || !isExtractorParser(parse)) return undefined;
  if (typeof selector !== 'string' || selector.trim() === '') return undefined;
  if (attribute !== undefined && attribute !== null && (typeof attribute !== 'string' || attribute.trim() === '')) {
    return undefined;
  }
  return { version, strategy, selector, attribute: attribute ?? null, parse };
}

export function hasExtractor(value: unknown): boolean {
  return parseExtractorSpec(value) !== undefined;
}

/**
 * The parser a watch of this kind needs its extractor to use, or `undefined`
 * for a kind this sprint does not check. Slot watches are slot-sniping's (s8).
 */
export function parserForKind(kind: WatchKind): ExtractorParser | undefined {
  switch (kind) {
    case 'price':
      return 'price';
    case 'change':
      return 'digest';
    case 'slot':
      return undefined;
  }
}
