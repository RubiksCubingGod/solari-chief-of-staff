import { FETCH_TIERS, type FetchTier, type TierPolicy } from '../index.js';
import { describeFetchError, type FetchAttempt, type FetchError, type FetchMeta } from './fetch.js';

/**
 * The tiered-fetching ladder (specs/tiered-fetching.md), minus the tiers.
 *
 * What lives here is the judgment: whether a page that came back is the page,
 * a refusal dressed as a page, or nothing at all; which tiers a watch may try;
 * and what the watch should remember afterwards. The tiers themselves - plain
 * HTTP, a browser, a stealth browser - are injected as fetchers, because the
 * engine package owns the network and the browser provider and this package
 * owns nothing that can fail on its own.
 *
 * The invariants: a block is the only thing that escalates; escalation is
 * monotonic within a check and cost-ordered; a fetch error ends the check at
 * its tier, because a timeout is not evidence that a browser would do better;
 * and a page that is gone is gone at every tier.
 */

export const BLOCK_SIGNALS = ['challenge-markers', 'block-status', 'empty-shell'] as const;
export type BlockSignal = (typeof BLOCK_SIGNALS)[number];

export type PageVerdict =
  | { readonly kind: 'ok' }
  | { readonly kind: 'blocked'; readonly signal: BlockSignal }
  | { readonly kind: 'gone' };

/** Statuses that mean "not for you" rather than "not here" or "broken". */
const BLOCK_STATUSES: ReadonlySet<number> = new Set([401, 403, 429, 503]);
const GONE_STATUSES: ReadonlySet<number> = new Set([404, 410]);

/**
 * What a challenge interstitial says to the person it is holding up. Matched
 * against visible body text only: the fixture's blocked shell keeps its title
 * after a script has materialised the real content, and a title is not a page.
 */
const CHALLENGE_TEXT: readonly RegExp[] = [
  /checking your browser/iu,
  /verify(?:ing)? (?:that )?you are (?:a )?human/iu,
  /enable javascript and cookies/iu,
  /complete the security check/iu,
  /are you a robot/iu,
  /access denied/iu,
  /attention required/iu,
];

/** Markup a challenge page carries whatever it says. Matched against the whole document. */
const CHALLENGE_MARKUP: readonly RegExp[] = [
  /\bg-recaptcha\b/u,
  /\bh-captcha\b/u,
  /challenge-platform|cf-chl|cf_chl/u,
  /captcha-challenge/u,
  /data-sitekey=/u,
];

/**
 * Fewer visible characters than this and the page is a shell waiting for a
 * script: a client-rendered application seen without a browser, or a block
 * page with nothing to say. Either way, the next tier is the only way to know.
 */
export const EMPTY_SHELL_TEXT_CHARS = 40;

/**
 * What a person would see: the body with scripts, styles, templates and the
 * noscript fallback removed, tags stripped, whitespace collapsed. Noscript is
 * removed rather than kept because its whole purpose is to speak to clients
 * that cannot run scripts, and "enable JavaScript" there is not a challenge.
 */
export function visibleText(html: string): string {
  const body = /<body[^>]*>([\s\S]*?)<\/body>/iu.exec(html)?.[1] ?? html;
  return body
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/giu, ' ')
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function classifyPage(html: string, status: number): PageVerdict {
  if (GONE_STATUSES.has(status)) return { kind: 'gone' };
  if (BLOCK_STATUSES.has(status)) return { kind: 'blocked', signal: 'block-status' };
  const text = visibleText(html);
  if (CHALLENGE_TEXT.some((pattern) => pattern.test(text)) || CHALLENGE_MARKUP.some((pattern) => pattern.test(html))) {
    return { kind: 'blocked', signal: 'challenge-markers' };
  }
  if (text.length < EMPTY_SHELL_TEXT_CHARS) return { kind: 'blocked', signal: 'empty-shell' };
  return { kind: 'ok' };
}

/**
 * The tiers one check may try, cheapest first. Under `auto` the ladder starts
 * at the floor the watch has learned and climbs; a pinned policy is exactly one
 * tier, whatever the floor says, because the person chose it.
 */
export function tiersToTry(policy: TierPolicy, floor: FetchTier): readonly FetchTier[] {
  if (policy !== 'auto') return [policy];
  return FETCH_TIERS.slice(FETCH_TIERS.indexOf(floor));
}

export type TierFetcher = (url: string) => Promise<FetchAttempt>;

export type LadderOutcome =
  | {
      readonly kind: 'fetched';
      readonly tier: FetchTier;
      readonly html: string;
      readonly meta: FetchMeta;
      readonly attempts: readonly FetchAttempt[];
    }
  | {
      readonly kind: 'blocked';
      readonly tiersTried: readonly FetchTier[];
      readonly signal: BlockSignal;
      readonly attempts: readonly FetchAttempt[];
    }
  | { readonly kind: 'gone'; readonly tier: FetchTier; readonly attempts: readonly FetchAttempt[] }
  | {
      readonly kind: 'error';
      readonly tier: FetchTier;
      readonly error: FetchError;
      readonly attempts: readonly FetchAttempt[];
    };

/**
 * Climb `tiers` in order until one serves the page. Every attempt is kept,
 * served or not, so the observation can say what it cost to learn what it
 * learned.
 */
export async function runLadder(
  url: string,
  tiers: readonly FetchTier[],
  fetchers: Readonly<Record<FetchTier, TierFetcher>>,
): Promise<LadderOutcome> {
  if (tiers.length === 0) throw new Error('the ladder needs at least one tier');
  const attempts: FetchAttempt[] = [];
  let signal: BlockSignal = 'empty-shell';
  for (const tier of tiers) {
    const attempt = await fetchers[tier](url);
    attempts.push(attempt);
    if (!attempt.ok) return { kind: 'error', tier, error: attempt.error, attempts };
    const verdict = classifyPage(attempt.html, attempt.meta.status);
    if (verdict.kind === 'ok') return { kind: 'fetched', tier, html: attempt.html, meta: attempt.meta, attempts };
    if (verdict.kind === 'gone') return { kind: 'gone', tier, attempts };
    signal = verdict.signal;
  }
  return { kind: 'blocked', tiersTried: [...tiers], signal, attempts };
}

/**
 * The floor after a check. It only ever rises: the tier that served the page
 * is what the site needs, and trying below it next time would pay to be
 * refused again. Nothing served means nothing learned.
 */
export function tierFloorAfter(floor: FetchTier, outcome: LadderOutcome): FetchTier {
  if (outcome.kind !== 'fetched') return floor;
  return FETCH_TIERS.indexOf(outcome.tier) > FETCH_TIERS.indexOf(floor) ? outcome.tier : floor;
}

export function describeOutcome(outcome: LadderOutcome): string {
  switch (outcome.kind) {
    case 'fetched':
      return `fetched at the ${outcome.tier} tier`;
    case 'blocked':
      return `blocked at every tier tried (${outcome.tiersTried.join(', ')}): ${outcome.signal}`;
    case 'gone':
      return 'the page is gone (404 or 410)';
    case 'error':
      return `fetch failed at the ${outcome.tier} tier: ${describeFetchError(outcome.error)}`;
  }
}
