import type { Task, TaskEvent, TaskTimeline } from '@chief-of-staff/db';
import { describe, expect, it } from 'vitest';

import { classifyOutcome, compareToBaseline, endingReason, summarize, verdictOf, type ScenarioResult } from './outcome.js';

/* Timelines with only what the classifier reads: a status, and the transitions' details. */

function timeline(status: Task['status'], events: readonly unknown[] = []): TaskTimeline {
  return { task: { status } as Task, events: events as unknown as TaskEvent[] };
}

const transition = (detail: unknown): unknown => ({
  type: 'transition',
  payload: { cause: 'error', from: 'running', to: 'failed', detail },
});

const declared = (status: unknown): unknown => transition({ reason: 'ended', detail: { mode: 'agentic', status } });

describe('classifyOutcome', () => {
  it('reads the settled statuses straight off the task', () => {
    expect(classifyOutcome(timeline('succeeded'))).toBe('succeeded');
    expect(classifyOutcome(timeline('waiting_user'))).toBe('needs_user');
    expect(classifyOutcome(timeline('cancelled'))).toBe('failed');
  });

  it('tells the failures apart by the status the mission declared on its last transition', () => {
    expect(classifyOutcome(timeline('failed', [declared('blocked')]))).toBe('failed-blocked');
    expect(classifyOutcome(timeline('failed', [declared('budget')]))).toBe('failed-budget');
    expect(classifyOutcome(timeline('failed', [declared('failed')]))).toBe('failed');
    expect(classifyOutcome(timeline('failed', [declared('blocked'), declared('budget')]))).toBe('failed-budget');
  });

  it('counts a failure with no declared status as a plain failure', () => {
    expect(classifyOutcome(timeline('failed'))).toBe('failed');
    expect(classifyOutcome(timeline('failed', [transition(undefined)]))).toBe('failed');
    expect(classifyOutcome(timeline('failed', [transition('the model threw')]))).toBe('failed');
    expect(classifyOutcome(timeline('failed', [transition({ reason: 'x', detail: 'not a record' })]))).toBe('failed');
    expect(classifyOutcome(timeline('failed', [transition({ reason: 'x', detail: ['blocked'] })]))).toBe('failed');
    expect(classifyOutcome(timeline('failed', [declared(7)]))).toBe('failed');
    expect(classifyOutcome(timeline('failed', [{ type: 'step', payload: { name: 'llm' } }]))).toBe('failed');
  });

  it('has no class for a task that has not settled', () => {
    expect(classifyOutcome(timeline('queued'))).toBeUndefined();
    expect(classifyOutcome(timeline('running'))).toBeUndefined();
  });
});

describe('endingReason', () => {
  it('reads the reason, the question or the words the engine left on the last transition', () => {
    expect(endingReason(timeline('failed', [transition({ reason: 'blocked: a challenge', detail: {} })]))).toBe(
      'blocked: a challenge',
    );
    expect(endingReason(timeline('waiting_user', [transition({ question: 'What is the code?' })]))).toBe(
      'What is the code?',
    );
    expect(endingReason(timeline('failed', [transition('the model threw')]))).toBe('the model threw');
    expect(endingReason(timeline('failed', [transition('first'), transition('last')]))).toBe('last');
  });

  it('has nothing to say when the transition carries none', () => {
    expect(endingReason(timeline('succeeded'))).toBeUndefined();
    expect(endingReason(timeline('failed', [transition(undefined)]))).toBeUndefined();
    expect(endingReason(timeline('failed', [transition({ reason: 7, question: null })]))).toBeUndefined();
  });
});

describe('verdictOf', () => {
  it('passes only an accepted ending with every state assertion holding', () => {
    expect(verdictOf(['succeeded'], 'succeeded', [])).toBe('passed');
    expect(verdictOf(['failed-blocked', 'needs_user'], 'needs_user', [])).toBe('passed');
    expect(verdictOf(['succeeded'], 'failed', [])).toBe('failed');
    expect(verdictOf(['succeeded'], 'succeeded', ['the member is active, not cancelled'])).toBe('failed');
  });
});

const result = (id: string, verdict: ScenarioResult['verdict']): ScenarioResult => ({
  id,
  verdict,
  expected: ['succeeded'],
  violations: [],
  durationMs: 1,
  llmUsage: null,
});

describe('summarize', () => {
  it('rates passed over the decided runs, leaving errored ones out of the denominator', () => {
    const results = [result('a', 'passed'), result('b', 'passed'), result('c', 'failed'), result('d', 'errored')];
    expect(summarize(results)).toEqual({ total: 4, passed: 2, failed: 1, errored: 1, passRate: 2 / 3 });
  });

  it('has no rate when nothing came to a verdict', () => {
    expect(summarize([])).toEqual({ total: 0, passed: 0, failed: 0, errored: 0, passRate: null });
    expect(summarize([result('a', 'errored')])).toEqual({ total: 1, passed: 0, failed: 0, errored: 1, passRate: null });
  });
});

describe('compareToBaseline', () => {
  const baseline = {
    scenarios: { steady: 'pass', regressed: 'pass', improved: 'fail', flaky: 'fail', gone: 'pass' },
  } as const;

  it('sorts every run into its bucket against the committed baseline', () => {
    const results = [
      result('steady', 'passed'),
      result('regressed', 'failed'),
      result('improved', 'passed'),
      result('flaky', 'failed'),
      result('outage', 'errored'),
      result('brand-new', 'passed'),
    ];
    expect(compareToBaseline(results, baseline)).toEqual({
      regressions: ['regressed'],
      improvements: ['improved'],
      errored: [],
      unlisted: ['outage', 'brand-new'],
      unrun: ['gone'],
      belowBaseline: true,
    });
  });

  it('reports an errored run beside the baseline, neither as a regression nor as an improvement', () => {
    const comparison = compareToBaseline([result('regressed', 'errored'), result('improved', 'errored')], {
      scenarios: { regressed: 'pass', improved: 'fail' },
    });
    expect(comparison).toEqual({
      regressions: [],
      improvements: [],
      errored: ['regressed', 'improved'],
      unlisted: [],
      unrun: [],
      belowBaseline: false,
    });
  });

  it('is below baseline on a regression, or on a listed scenario that did not run, and not otherwise', () => {
    const listed = { scenarios: { a: 'pass', b: 'fail' } } as const;
    expect(compareToBaseline([result('a', 'passed'), result('b', 'failed')], listed).belowBaseline).toBe(false);
    expect(compareToBaseline([result('a', 'passed'), result('b', 'passed')], listed).belowBaseline).toBe(false);
    expect(compareToBaseline([result('a', 'failed'), result('b', 'failed')], listed).belowBaseline).toBe(true);
    expect(compareToBaseline([result('a', 'passed')], listed).belowBaseline).toBe(true);
  });
});
