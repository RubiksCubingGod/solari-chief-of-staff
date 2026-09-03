import { describe, expect, it } from 'vitest';

import {
  RELEASE_GREEN_NIGHTS,
  judgeRecord,
  sumCaseCosts,
  summarizeNight,
  type CaseResult,
  type NightSummary,
} from '../index.js';

/**
 * The nightly's arithmetic, kept out of the script that runs the cases so it
 * can be proved without spending a cent. Three things have to be true of it:
 * a night is green, failed or errored and never two of those at once; the
 * cost is summed per vendor and held to a target; and the release count is
 * three consecutive greens, with one errored night neither counting nor
 * breaking the run and two in a row breaking it.
 */

const NO_COST = { solariUsd: 0, anthropicUsd: 0 };

function passed(id: string, kind: CaseResult['class'], cost = NO_COST): CaseResult {
  return { id, class: kind, outcome: 'passed', detail: 'ok', cost };
}

function failed(id: string, kind: CaseResult['class'], detail: string): CaseResult {
  return { id, class: kind, outcome: 'failed', detail, cost: NO_COST };
}

function errored(id: string, kind: CaseResult['class'], detail: string): CaseResult {
  return { id, class: kind, outcome: 'errored', detail, cost: NO_COST };
}

const ALL_GREEN: readonly CaseResult[] = [
  passed('session-lifecycle', 'session', { solariUsd: 0.02, anthropicUsd: 0 }),
  passed('watch-checks', 'watch', { solariUsd: 0.01, anthropicUsd: 0 }),
  passed('fixture-mission', 'mission', { solariUsd: 0.03, anthropicUsd: 0.4 }),
  passed('eval-suite', 'eval', { solariUsd: 0, anthropicUsd: 1.5 }),
];

describe('summarizeNight', () => {
  it('is green only when every case passed and the cost is under target', () => {
    const night = summarizeNight({ date: '2026-09-03', cases: ALL_GREEN, costTargetUsd: 5 });
    expect(night.colour).toBe('green');
    expect(night.counts).toEqual({ passed: 4, failed: 0, errored: 0 });
    expect(night.overTarget).toBe(false);
    expect(night.reasons).toEqual([]);
  });

  it('counts failed and errored cases apart, and one failure colours the night failed', () => {
    const night = summarizeNight({
      date: '2026-09-03',
      cases: [
        ALL_GREEN[0]!,
        failed('watch-checks', 'watch', 'the price selector matched nothing'),
        errored('fixture-mission', 'mission', 'the vendor answered 503'),
        ALL_GREEN[3]!,
      ],
      costTargetUsd: 5,
    });
    expect(night.colour).toBe('failed');
    expect(night.counts).toEqual({ passed: 2, failed: 1, errored: 1 });
    // Each reason names the case, its class, and which of the two it was: a
    // person reading the notification must not have to guess.
    const watch = night.reasons.find((reason) => reason.includes('watch-checks'));
    const mission = night.reasons.find((reason) => reason.includes('fixture-mission'));
    expect(watch).toContain('failed');
    expect(watch).toContain('the price selector matched nothing');
    expect(mission).toContain('errored');
    expect(mission).toContain('the vendor answered 503');
    expect(night.reasons).toHaveLength(2);
  });

  it('is errored, never green, when a case errored and nothing failed', () => {
    const night = summarizeNight({
      date: '2026-09-03',
      cases: [ALL_GREEN[0]!, ALL_GREEN[1]!, errored('fixture-mission', 'mission', 'no browser'), ALL_GREEN[3]!],
      costTargetUsd: 5,
    });
    expect(night.colour).toBe('errored');
    expect(night.counts).toEqual({ passed: 3, failed: 0, errored: 1 });
  });

  it('is errored when no case ran at all', () => {
    const night = summarizeNight({ date: '2026-09-03', cases: [], costTargetUsd: 5 });
    expect(night.colour).toBe('errored');
    expect(night.reasons.join('\n')).toMatch(/no case ran/u);
  });

  it('sums Solari and Anthropic cost apart, and both against the target', () => {
    const night = summarizeNight({ date: '2026-09-03', cases: ALL_GREEN, costTargetUsd: 5 });
    expect(night.cost).toEqual({ solariUsd: 0.06, anthropicUsd: 1.9, totalUsd: 1.96 });
    expect(sumCaseCosts(ALL_GREEN)).toEqual(night.cost);
    expect(night.costTargetUsd).toBe(5);
  });

  it('fails a night that ran over target even when every case passed', () => {
    const night = summarizeNight({ date: '2026-09-03', cases: ALL_GREEN, costTargetUsd: 1 });
    expect(night.colour).toBe('failed');
    expect(night.overTarget).toBe(true);
    expect(night.reasons).toHaveLength(1);
    expect(night.reasons[0]).toContain('$1.96');
    expect(night.reasons[0]).toContain('$1.00');
  });
});

describe('judgeRecord', () => {
  const night = (date: string, colour: NightSummary['colour']): Pick<NightSummary, 'date' | 'colour'> => ({
    date,
    colour,
  });

  it('needs three consecutive green nights, and says how many it has', () => {
    expect(RELEASE_GREEN_NIGHTS).toBe(3);
    expect(judgeRecord([night('2026-09-01', 'green'), night('2026-09-02', 'green')])).toMatchObject({
      consecutiveGreen: 2,
      releaseReady: false,
    });
    expect(
      judgeRecord([night('2026-09-01', 'green'), night('2026-09-02', 'green'), night('2026-09-03', 'green')]),
    ).toMatchObject({ consecutiveGreen: 3, releaseReady: true });
  });

  it('starts the count again after a failed night', () => {
    const verdict = judgeRecord([
      night('2026-09-01', 'green'),
      night('2026-09-02', 'green'),
      night('2026-09-03', 'failed'),
      night('2026-09-04', 'green'),
    ]);
    expect(verdict).toMatchObject({ consecutiveGreen: 1, releaseReady: false });
    expect(verdict.reason).toContain('2026-09-03');
  });

  it('lets one errored night pass without counting it or breaking the run', () => {
    expect(
      judgeRecord([night('2026-09-01', 'green'), night('2026-09-02', 'errored'), night('2026-09-03', 'green')]),
    ).toMatchObject({ consecutiveGreen: 2, releaseReady: false });
    expect(
      judgeRecord([
        night('2026-09-01', 'green'),
        night('2026-09-02', 'errored'),
        night('2026-09-03', 'green'),
        night('2026-09-04', 'green'),
      ]),
    ).toMatchObject({ consecutiveGreen: 3, releaseReady: true });
  });

  it('breaks the run on two errored nights in a row', () => {
    const verdict = judgeRecord([
      night('2026-09-01', 'green'),
      night('2026-09-02', 'green'),
      night('2026-09-03', 'errored'),
      night('2026-09-04', 'errored'),
      night('2026-09-05', 'green'),
    ]);
    expect(verdict).toMatchObject({ consecutiveGreen: 1, releaseReady: false });
    expect(verdict.reason).toContain('2026-09-04');
  });

  it('is not ready on an empty record', () => {
    expect(judgeRecord([])).toMatchObject({ consecutiveGreen: 0, releaseReady: false });
  });

  it('reads the nights in date order, whatever order the record lists them', () => {
    expect(
      judgeRecord([night('2026-09-03', 'green'), night('2026-09-01', 'failed'), night('2026-09-02', 'green')]),
    ).toMatchObject({ consecutiveGreen: 2 });
  });
});
