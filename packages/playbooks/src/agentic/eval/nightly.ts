import { readFileSync } from 'node:fs';

import { compareToBaseline, summarize, type Baseline, type BaselineEntry, type ScenarioResult } from './outcome.js';
import { runScenario, type EvalBench, type RunOptions } from './runner.js';
import type { Scenario } from './scenarios.js';

/**
 * The nightly's rules: the committed baseline and what may be in it, the
 * spend cap the live suite runs under, and the report it leaves behind with
 * the exit code it decides.
 *
 * The baseline is a file, on purpose. A pass rate that floats with the last
 * run cannot catch drift, because drift moves the bar with it; a file in the
 * repository moves only when a person edits it in a pull request, so a night
 * that ends below it is a night somebody has to look at. The report says
 * what it would set the file to, and a person decides whether to.
 *
 * The cap is a meter over what the engine recorded on each task, checked
 * before every scenario and never mid-run: a scenario either runs whole or
 * is reported as not run, and a real model that starts to loop is stopped
 * by the run's own budgets long before the cap notices.
 */

/** Where the baseline lives, as the repository knows the path: what the report tells a person to edit. */
export const BASELINE_FILE = 'packages/playbooks/src/agentic/eval/baseline.json';
const BASELINE_URL = new URL('./baseline.json', import.meta.url);

/** The most a live run may spend, in dollars, before the rest of the suite is reported as not run. */
export const SPEND_CAP_VARIABLE = 'LIVE_EVAL_SPEND_CAP_USD';
export const DEFAULT_SPEND_CAP_USD = 5;
/** Where the live suite writes its report and the baseline it would set, for the workflow to keep. */
export const REPORT_DIR_VARIABLE = 'LIVE_EVAL_REPORT_DIR';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isEntry = (value: unknown): value is BaselineEntry => value === 'pass' || value === 'fail';

/** The baseline the text describes, or an error naming what is wrong with it. */
export function parseBaseline(text: string): Baseline {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${BASELINE_FILE} is not JSON: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  if (!isRecord(parsed) || !isRecord(parsed['scenarios'])) {
    throw new Error(`${BASELINE_FILE} is not a baseline: expected an object with "scenarios"`);
  }
  const note = parsed['note'];
  if (note !== undefined && typeof note !== 'string') {
    throw new Error(`${BASELINE_FILE} is not a baseline: "note" is not a string`);
  }
  const scenarios: Record<string, BaselineEntry> = {};
  for (const [id, entry] of Object.entries(parsed['scenarios'])) {
    if (!isEntry(entry)) {
      throw new Error(
        `${BASELINE_FILE} is not a baseline: scenario "${id}" is ${JSON.stringify(entry)}, not "pass" or "fail"`,
      );
    }
    scenarios[id] = entry;
  }
  return { ...(note === undefined ? {} : { note }), scenarios };
}

/** The committed baseline, read fresh: the bar tonight's run is held to. */
export function readBaseline(): Baseline {
  return parseBaseline(readFileSync(BASELINE_URL, 'utf8'));
}

/** The cap from the environment, or the default when nothing is set. */
export function spendCapFrom(env: Readonly<Record<string, string | undefined>>): number {
  const raw = (env[SPEND_CAP_VARIABLE] ?? '').trim();
  if (raw === '') return DEFAULT_SPEND_CAP_USD;
  const cap = Number(raw);
  if (!Number.isFinite(cap) || cap < 0) {
    throw new Error(`${SPEND_CAP_VARIABLE} is ${JSON.stringify(raw)}, not a number of dollars`);
  }
  return cap;
}

export interface SpendMeter {
  readonly capUsd: number;
  /** What the runs so far cost, from the usage the engine recorded on each task. */
  spentUsd(): number;
  /** True once the cap is spent: nothing more runs. */
  exhausted(): boolean;
  charge(result: ScenarioResult): void;
}

export function createSpendMeter(capUsd: number): SpendMeter {
  if (!Number.isFinite(capUsd) || capUsd < 0) {
    throw new Error(`a spend cap is a number of dollars, zero or more, not ${String(capUsd)}`);
  }
  let spent = 0;
  return {
    capUsd,
    spentUsd: () => spent,
    exhausted: () => spent >= capUsd,
    charge: (result) => {
      spent += result.llmUsage?.costUsd ?? 0;
    },
  };
}

/**
 * The scenario, unless the meter is spent, in which case an errored result
 * that says so: the scenario did not run, and the baseline's word stands.
 */
export async function runUnderCap(
  bench: EvalBench,
  scenario: Scenario,
  options: RunOptions,
  meter: SpendMeter,
): Promise<ScenarioResult> {
  if (meter.exhausted()) {
    return {
      id: scenario.id,
      verdict: 'errored',
      expected: scenario.expect,
      violations: [],
      error: `not run: the spend cap of $${meter.capUsd.toFixed(2)} was reached, with $${meter.spentUsd().toFixed(4)} spent`,
      durationMs: 0,
      llmUsage: null,
    };
  }
  const result = await runScenario(bench, scenario, options);
  meter.charge(result);
  return result;
}

export interface NightlyReport {
  /** 1 below baseline, or when no scenario came to a verdict; 0 otherwise. */
  readonly exitCode: 0 | 1;
  readonly lines: readonly string[];
  /** The baseline this run would set: every verdict written in, every errored entry left as it was. */
  readonly candidate: Baseline;
}

const money = (usd: number): string => `$${usd.toFixed(4)}`;
const list = (ids: readonly string[]): string => (ids.length === 0 ? 'none' : ids.join(', '));

function describeResult(result: ScenarioResult): string {
  switch (result.verdict) {
    case 'passed':
      return `${result.actual ?? 'no outcome'} in ${(result.durationMs / 1000).toFixed(1)}s for ${money(result.llmUsage?.costUsd ?? 0)}`;
    case 'failed': {
      const reason = result.reason === undefined ? '' : `: ${result.reason}`;
      const violations = result.violations.length === 0 ? '' : `; ${result.violations.join('; ')}`;
      return `expected ${result.expected.join(' or ')}, got ${result.actual ?? 'no outcome'}${reason}${violations}`;
    }
    case 'errored':
      return `no verdict: ${result.error ?? 'no error recorded'}`;
  }
}

function candidateFrom(results: readonly ScenarioResult[], baseline: Baseline): Baseline {
  const scenarios: Record<string, BaselineEntry> = { ...baseline.scenarios };
  for (const result of results) {
    if (result.verdict === 'passed') scenarios[result.id] = 'pass';
    else if (result.verdict === 'failed') scenarios[result.id] = 'fail';
  }
  const sorted = Object.fromEntries(Object.entries(scenarios).sort(([a], [b]) => a.localeCompare(b)));
  return { ...(baseline.note === undefined ? {} : { note: baseline.note }), scenarios: sorted };
}

/**
 * What the run says, held to the baseline. Errored scenarios are reported
 * apart: an outage is not a regression, and does not fail the night on its
 * own - unless nothing at all came to a verdict, when a green run would be
 * the one thing this report must never produce.
 */
export function nightlyReport(
  results: readonly ScenarioResult[],
  baseline: Baseline,
  meter?: Pick<SpendMeter, 'capUsd' | 'spentUsd'>,
): NightlyReport {
  const summary = summarize(results);
  const comparison = compareToBaseline(results, baseline);
  const decided = summary.passed + summary.failed;
  const rate =
    summary.passRate === null
      ? 'no pass rate, since none came to a verdict'
      : `pass rate ${String(Math.round(summary.passRate * 100))}% of ${String(decided)} decided`;
  const lines: string[] = [
    `live evals: ${String(summary.total)} run; ${String(summary.passed)} passed, ${String(summary.failed)} failed, ${String(summary.errored)} errored; ${rate}`,
  ];
  if (meter !== undefined) lines.push(`spent ${money(meter.spentUsd())} of the $${meter.capUsd.toFixed(2)} cap`);
  for (const result of results) lines.push(`  ${result.verdict.padEnd(7)} ${result.id}: ${describeResult(result)}`);
  lines.push(
    `regressions (passed at baseline, failed now): ${list(comparison.regressions)}`,
    `improvements (failed at baseline, passed now; raise the bar by editing ${BASELINE_FILE} in a PR): ${list(comparison.improvements)}`,
    `errored (no verdict, so the baseline entry stands; an outage is not a regression): ${list(comparison.errored)}`,
    `unlisted (ran, but ${BASELINE_FILE} has no entry; add one in a PR): ${list(comparison.unlisted)}`,
    `unrun (listed in ${BASELINE_FILE}, but did not run): ${list(comparison.unrun)}`,
  );
  let exitCode: 0 | 1 = 0;
  if (comparison.belowBaseline) {
    exitCode = 1;
    lines.push('verdict: below baseline');
  } else if (summary.passRate === null) {
    exitCode = 1;
    lines.push('verdict: no verdict at all; not a regression, but not a pass either');
  } else {
    lines.push('verdict: at or above baseline');
  }
  return { exitCode, lines, candidate: candidateFrom(results, baseline) };
}
