import {
  runLadder,
  tierFloorAfter,
  tiersToTry,
  type FetchTier,
  type LadderOutcome,
  type TierFetcher,
  type WatchRecord,
  type WatchStore,
} from '@chief-of-staff/core';
import type { BrowserProvider } from '@chief-of-staff/solari';

import { fetchBrowser } from './browser.js';
import { fetchHttp, type HttpFetchOptions } from './http.js';

/**
 * The ladder with its tiers attached: plain HTTP, then a browser from the
 * provider, then the same provider asked for stealth. One of these per process;
 * it holds no per-watch state, and every watch's check goes through it.
 */

export interface FetchLadderOptions {
  readonly provider: BrowserProvider;
  readonly http?: HttpFetchOptions;
  readonly browserTimeoutMs?: number;
  /**
   * Headers the escalation tier sends and the tiers below it do not. A real
   * deployment has none: stealth is the provider's business. The fixture shop's
   * hard-blocked mode serves the page only to a request carrying its marker,
   * which is what lets a local Chromium prove the ladder reaches tier 2.
   */
  readonly escalationHeaders?: Readonly<Record<string, string>>;
}

export type WatchFetchTarget = Pick<WatchRecord, 'url' | 'tierPolicy' | 'tierFloor'>;

export interface FetchLadder {
  fetchPage(target: WatchFetchTarget): Promise<LadderOutcome>;
}

export function createFetchLadder(options: FetchLadderOptions): FetchLadder {
  const { provider } = options;
  const http = options.http ?? {};
  const browser = options.browserTimeoutMs === undefined ? {} : { timeoutMs: options.browserTimeoutMs };
  const escalation = options.escalationHeaders === undefined ? {} : { headers: options.escalationHeaders };

  const fetchers: Readonly<Record<FetchTier, TierFetcher>> = {
    http: (url) => fetchHttp(url, http),
    browser: (url) => fetchBrowser(url, { provider, tier: 'browser', ...browser }),
    stealth: (url) => fetchBrowser(url, { provider, tier: 'stealth', ...browser, ...escalation }),
  };

  return {
    fetchPage: (target) => runLadder(target.url, tiersToTry(target.tierPolicy, target.tierFloor), fetchers),
  };
}

export type WatchFetchSubject = Pick<WatchRecord, 'id' | 'url' | 'tierPolicy' | 'tierFloor'>;

export interface WatchFetch {
  readonly outcome: LadderOutcome;
  /** The floor the watch has after this check, persisted if it rose. */
  readonly tierFloor: FetchTier;
}

/**
 * Fetch for a persisted watch and remember what it took. The floor is written
 * only when it rises, which is the sticky-tier rule from the spec: a site that
 * needed a browser once needs one next time, and the check should not pay for
 * the refusal again to find that out.
 */
export async function fetchWatchPage(
  ladder: FetchLadder,
  store: Pick<WatchStore, 'updateWatch'>,
  watch: WatchFetchSubject,
): Promise<WatchFetch> {
  const outcome = await ladder.fetchPage(watch);
  const tierFloor = tierFloorAfter(watch.tierFloor, outcome);
  if (tierFloor !== watch.tierFloor) await store.updateWatch(watch.id, { tierFloor });
  return { outcome, tierFloor };
}
