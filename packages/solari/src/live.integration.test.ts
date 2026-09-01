import { describe, expect, it } from 'vitest';

import {
  API_KEY_VARIABLE,
  liveSmokeSkipReason,
  REPLAY_POLL_TIMEOUT_MS,
  runLiveSmoke,
} from './live-smoke.js';

/**
 * The nightly early-warning line. Every other test in this package proves the
 * adapter against something we control; this one proves it against the vendor.
 *
 * It lives in the ordinary `integration` project on purpose. Excluding it in
 * `vitest.config.ts` would keep it out of the run, but it would also stop the
 * file being loaded at all, and a live suite that nobody ever imports is one
 * that has quietly stopped compiling by the time it is needed. Instead the
 * guard skips it, so the ordinary gate collects it, typechecks it, lints it,
 * and spends nothing.
 */

const skipReason = liveSmokeSkipReason(process.env);

/**
 * The reason rides in the suite name so the ordinary run reports *why* it
 * skipped rather than reporting nothing. The spec's rule is that a missing
 * secret must read as skipped and never as green; a nameless skip is halfway
 * back to silent.
 */
const suiteName =
  skipReason === undefined ? 'the Solari live smoke' : `the Solari live smoke — ${skipReason}`;

/** Launch, navigate, flush, release, then poll the replay through its 404 window. */
const LIVE_SMOKE_TIMEOUT_MS = REPLAY_POLL_TIMEOUT_MS + 150_000;

describe.skipIf(skipReason !== undefined)(suiteName, () => {
  it(
    'drives a recorded session end to end, retrieves its replay, and leaves nothing live',
    async () => {
      const apiKey = process.env[API_KEY_VARIABLE] ?? '';
      const report = await runLiveSmoke({ apiKey });

      expect(report.sessionId).not.toBe('');

      // A stable public page. Lowercased and loosened by a hair, because the
      // point of the assertion is "a real browser really rendered a real page",
      // and an alarm that fires on someone else's whitespace is an alarm people
      // learn to ignore.
      expect(report.title.toLowerCase()).toContain('example domain');

      expect(report.replayUrl).toMatch(/^https:\/\//u);
      expect(report.replayBytes).toBeGreaterThan(0);

      // The finding the research could not settle, now pinned. The object is
      // stored gzipped and the presigned response says so, which is precisely
      // why what arrives is *not* gzipped: undici inflates it on the way past.
      // A flip here is not a flake - it means a replay parser written against
      // Node's fetch would start receiving bytes it must gunzip, and the two
      // ways of getting that wrong both fail quietly.
      expect(report.replayContentEncoding).toBe('gzip');
      expect(report.replayResponseEncoding).toBe('gzip');
      expect(report.replayBodyShape).toBe('ndjson');

      // There is no server-side list to consult, so this ledger is the only
      // record of what we hold. A leftover id here is a concurrency slot burning
      // until the orphan reaper runs.
      expect(report.liveSessionIdsAfterRelease).toEqual([]);
    },
    LIVE_SMOKE_TIMEOUT_MS,
  );
});
