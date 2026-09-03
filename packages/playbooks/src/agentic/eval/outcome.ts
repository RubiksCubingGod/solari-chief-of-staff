import type { TaskLlmUsage, TransitionEventPayload } from '@chief-of-staff/core';
import type { TaskTimeline } from '@chief-of-staff/db';

/**
 * How an eval counts a mission's ending, and how it counts its own runs.
 *
 * Pure: a settled timeline in, a class out; results in, a summary and a
 * comparison against the committed baseline out. Nothing here runs a
 * browser, so every branch is a unit test away.
 */

/**
 * The classes a scenario declares as acceptable endings. `succeeded` is the
 * task's own status; `needs_user` is a task parked on a question nobody
 * answered - the escalation ask on a hard block, the payment gate; the three
 * `failed-` classes are told apart by the status the mission declared when
 * it ended, which the runner puts on the failed transition.
 */
export const OUTCOME_CLASSES = ['succeeded', 'needs_user', 'failed-blocked', 'failed-budget', 'failed'] as const;
export type OutcomeClass = (typeof OUTCOME_CLASSES)[number];

/**
 * What a run of one scenario came to. `errored` is the bench's word, never
 * the loop's: the fixture would not seed, the API was down, the task never
 * settled. It is reported beside `failed` and never inside it.
 */
export type Verdict = 'passed' | 'failed' | 'errored';

export interface ScenarioResult {
  readonly id: string;
  readonly verdict: Verdict;
  readonly expected: readonly OutcomeClass[];
  /** The class the run ended in; absent when the run errored before there was one. */
  readonly actual?: OutcomeClass;
  /** Why it ended so, in the loop's words: the reason or question on the last transition, when there was one. */
  readonly reason?: string;
  /** The state assertions that did not hold, in the scenario's words. Empty when they all held. */
  readonly violations: readonly string[];
  /** Why the run errored, when it did. */
  readonly error?: string;
  readonly durationMs: number;
  /** What the run cost, as the task row carries it; null when the model was never called. */
  readonly llmUsage: TaskLlmUsage | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lastTransition(timeline: TaskTimeline): TransitionEventPayload | undefined {
  return timeline.events
    .filter((event) => event.type === 'transition')
    .map((event) => event.payload as TransitionEventPayload)
    .at(-1);
}

/** The status the mission's ending declared, read off the last transition's detail. */
function declaredStatus(timeline: TaskTimeline): string | undefined {
  const outer = lastTransition(timeline)?.detail;
  if (!isRecord(outer)) return undefined;
  const inner = outer['detail'];
  if (!isRecord(inner)) return undefined;
  const status = inner['status'];
  return typeof status === 'string' ? status : undefined;
}

/**
 * The class a settled timeline belongs to, or nothing when the task has not
 * settled: a task still queued or running has no ending to classify, and the
 * runner reports that as an error of the bench rather than guess at one.
 */
export function classifyOutcome(timeline: TaskTimeline): OutcomeClass | undefined {
  switch (timeline.task.status) {
    case 'succeeded':
      return 'succeeded';
    case 'waiting_user':
      return 'needs_user';
    case 'failed': {
      const status = declaredStatus(timeline);
      if (status === 'blocked') return 'failed-blocked';
      if (status === 'budget') return 'failed-budget';
      return 'failed';
    }
    case 'cancelled':
      // Nobody cancels an eval's task on purpose; a cancelled one did not succeed.
      return 'failed';
    default:
      return undefined;
  }
}

/**
 * Why the task ended as it did, as the last transition put it: the failure's
 * reason, the question it parked on, or the engine's own words when it was
 * the engine that failed. Nothing when the transition carries none.
 */
export function endingReason(timeline: TaskTimeline): string | undefined {
  const detail = lastTransition(timeline)?.detail;
  if (typeof detail === 'string') return detail;
  if (!isRecord(detail)) return undefined;
  const reason = detail['reason'];
  if (typeof reason === 'string') return reason;
  const question = detail['question'];
  return typeof question === 'string' ? question : undefined;
}

/** Passed when the ending is one the scenario accepts and every state assertion held. */
export function verdictOf(
  expected: readonly OutcomeClass[],
  actual: OutcomeClass,
  violations: readonly string[],
): 'passed' | 'failed' {
  return expected.includes(actual) && violations.length === 0 ? 'passed' : 'failed';
}

export interface EvalSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly errored: number;
  /**
   * Passed over passed plus failed. An errored run is not in the
   * denominator: an outage must not read as a regression, nor pad the rate
   * when it happens to strike a scenario that would have failed. Null when
   * nothing came to a verdict at all.
   */
  readonly passRate: number | null;
}

export function summarize(results: readonly ScenarioResult[]): EvalSummary {
  const count = (verdict: Verdict): number => results.filter((result) => result.verdict === verdict).length;
  const passed = count('passed');
  const failed = count('failed');
  const decided = passed + failed;
  return {
    total: results.length,
    passed,
    failed,
    errored: count('errored'),
    passRate: decided === 0 ? null : passed / decided,
  };
}

/** What the committed baseline says each scenario did on the run that set it. */
export type BaselineEntry = 'pass' | 'fail';

export interface Baseline {
  /** For the reader of the file: what it is and how it moves. Kept as written. */
  readonly note?: string;
  readonly scenarios: Readonly<Record<string, BaselineEntry>>;
}

export interface BaselineComparison {
  /** Passed at baseline, failed now: what a nightly job fails on. */
  readonly regressions: readonly string[];
  /** Failed at baseline, passed now: worth a baseline edit, never an automatic one. */
  readonly improvements: readonly string[];
  /** No verdict this run; the baseline's word stands, reported so silence is not read as green. */
  readonly errored: readonly string[];
  /** Ran, but the baseline does not list them: new scenarios awaiting their first entry. */
  readonly unlisted: readonly string[];
  /** Listed, but did not run: a suite that shrank without its baseline being edited. */
  readonly unrun: readonly string[];
  /** A regression, or a listed scenario that did not run. */
  readonly belowBaseline: boolean;
}

export function compareToBaseline(results: readonly ScenarioResult[], baseline: Baseline): BaselineComparison {
  const regressions: string[] = [];
  const improvements: string[] = [];
  const errored: string[] = [];
  const unlisted: string[] = [];
  const ran = new Set<string>();
  for (const result of results) {
    ran.add(result.id);
    const entry = baseline.scenarios[result.id];
    if (entry === undefined) {
      unlisted.push(result.id);
      continue;
    }
    if (result.verdict === 'errored') errored.push(result.id);
    else if (entry === 'pass' && result.verdict === 'failed') regressions.push(result.id);
    else if (entry === 'fail' && result.verdict === 'passed') improvements.push(result.id);
  }
  const unrun = Object.keys(baseline.scenarios).filter((id) => !ran.has(id));
  return {
    regressions,
    improvements,
    errored,
    unlisted,
    unrun,
    belowBaseline: regressions.length > 0 || unrun.length > 0,
  };
}
