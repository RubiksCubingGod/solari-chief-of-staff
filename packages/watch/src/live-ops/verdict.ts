import { roundUsd } from '@chief-of-staff/core';

/**
 * The nightly live-ops gate's arithmetic: what a night is, and what three of
 * them add up to.
 *
 * Kept apart from the script that spends the money so it can be proved for
 * free, and so the words in a notification - "failed", "errored", "green" -
 * mean one thing each. A case that ran and said no is *failed*; a case that
 * could not say anything, because a vendor was away or a runner had no
 * browser, is *errored*. The two are never merged: a failure is a regression
 * somebody has to look at, an error is an outage that may not be ours, and
 * a report that called both "red" would have a person chasing the wrong one.
 *
 * Cost is part of the verdict. The gate exists to find out whether the
 * product can be run for what the plan says, so a night that ran over the
 * target has failed the thing it was measuring, however green its cases.
 */

/** The four things a night proves, one case class each. */
export const CASE_CLASSES = ['session', 'watch', 'mission', 'eval'] as const;
export type CaseClass = (typeof CASE_CLASSES)[number];

export const CASE_OUTCOMES = ['passed', 'failed', 'errored'] as const;
export type CaseOutcome = (typeof CASE_OUTCOMES)[number];

/** What a case spent, per vendor, in dollars. */
export interface CaseCost {
  readonly solariUsd: number;
  readonly anthropicUsd: number;
}

export interface CaseResult {
  readonly id: string;
  readonly class: CaseClass;
  readonly outcome: CaseOutcome;
  /** One line: what passed, why it failed, or what stopped it from saying. */
  readonly detail: string;
  readonly cost: CaseCost;
}

export type NightColour = 'green' | 'failed' | 'errored';

export interface NightCost extends CaseCost {
  readonly totalUsd: number;
}

export interface NightInput {
  /** The night's date, `YYYY-MM-DD`, in UTC. */
  readonly date: string;
  readonly cases: readonly CaseResult[];
  /** The most the night may spend across both vendors, in dollars. */
  readonly costTargetUsd: number;
}

export interface NightSummary {
  readonly date: string;
  readonly colour: NightColour;
  readonly counts: Readonly<Record<CaseOutcome, number>>;
  readonly cases: readonly CaseResult[];
  readonly cost: NightCost;
  readonly costTargetUsd: number;
  readonly overTarget: boolean;
  /** Why the night is not green, one line each; empty when it is. */
  readonly reasons: readonly string[];
}

/** How many green nights in a row the release wants. */
export const RELEASE_GREEN_NIGHTS = 3;

export interface RecordVerdict {
  readonly consecutiveGreen: number;
  readonly releaseReady: boolean;
  readonly reason: string;
}

const money = (usd: number): string => `$${usd.toFixed(2)}`;

export function sumCaseCosts(cases: readonly Pick<CaseResult, 'cost'>[]): NightCost {
  let solariUsd = 0;
  let anthropicUsd = 0;
  for (const { cost } of cases) {
    solariUsd += cost.solariUsd;
    anthropicUsd += cost.anthropicUsd;
  }
  solariUsd = roundUsd(solariUsd);
  anthropicUsd = roundUsd(anthropicUsd);
  return { solariUsd, anthropicUsd, totalUsd: roundUsd(solariUsd + anthropicUsd) };
}

export function summarizeNight(input: NightInput): NightSummary {
  const counts = { passed: 0, failed: 0, errored: 0 };
  const reasons: string[] = [];
  for (const result of input.cases) {
    counts[result.outcome] += 1;
    if (result.outcome !== 'passed') {
      reasons.push(`${result.class} case ${result.id} ${result.outcome}: ${result.detail}`);
    }
  }
  const cost = sumCaseCosts(input.cases);
  const overTarget = cost.totalUsd > input.costTargetUsd;
  if (overTarget) {
    reasons.push(
      `cost ${money(cost.totalUsd)} ran over the target of ${money(input.costTargetUsd)} (Solari ${money(cost.solariUsd)}, Anthropic ${money(cost.anthropicUsd)})`,
    );
  }
  if (input.cases.length === 0) reasons.push('no case ran, so the night proved nothing');

  const colour: NightColour =
    counts.failed > 0 || overTarget ? 'failed' : counts.errored > 0 || input.cases.length === 0 ? 'errored' : 'green';

  return {
    date: input.date,
    colour,
    counts,
    cases: input.cases,
    cost,
    costTargetUsd: input.costTargetUsd,
    overTarget,
    reasons,
  };
}

/**
 * The count of green nights in a row, read back from the latest. A failed
 * night ends the count. An errored night on its own is skipped - an outage
 * is not a regression and should not cost the record its history - but two
 * in a row end it too, because a suite that cannot run two nights running is
 * one nobody can vouch for.
 */
export function judgeRecord(nights: readonly Pick<NightSummary, 'date' | 'colour'>[]): RecordVerdict {
  const ordered = [...nights].sort((a, b) => a.date.localeCompare(b.date));
  let consecutiveGreen = 0;
  let broken: string | undefined;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const night = ordered[index]!;
    if (night.colour === 'green') {
      consecutiveGreen += 1;
      continue;
    }
    if (night.colour === 'failed') {
      broken = `${night.date} failed`;
      break;
    }
    const previous = ordered[index - 1];
    if (previous?.colour === 'errored') {
      broken = `${previous.date} and ${night.date} both errored`;
      break;
    }
  }

  const releaseReady = consecutiveGreen >= RELEASE_GREEN_NIGHTS;
  const have =
    ordered.length === 0
      ? 'no nights on record'
      : `${String(consecutiveGreen)} green night${consecutiveGreen === 1 ? '' : 's'} in a row`;
  const reason = releaseReady
    ? `${have}; the release wants ${String(RELEASE_GREEN_NIGHTS)}`
    : `${have}${broken === undefined ? '' : ` since ${broken}`}; the release wants ${String(RELEASE_GREEN_NIGHTS)}`;
  return { consecutiveGreen, releaseReady, reason };
}
