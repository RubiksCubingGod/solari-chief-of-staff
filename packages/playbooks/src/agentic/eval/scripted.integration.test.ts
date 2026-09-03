import { startTestPostgres, type TestPostgres } from '@chief-of-staff/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OUTCOME_CLASSES, summarize } from './outcome.js';
import { runScenario, runScenarios, startEvalBench, type EvalBench } from './runner.js';
import { SCENARIOS, scenario, type Scenario } from './scenarios.js';

/**
 * The scripted eval suite, the one CI runs on every push. Every scenario of
 * the starting suite goes through the production path - the engine on a
 * pg-boss worker, the registry falling through to the agentic mission, a
 * local Chromium under the guardrails, the fixture in the mode the scenario
 * asks for - with the model played from the scenario's own script, and must
 * pass on both counts: the outcome class it declares, and the state the
 * fixture's control plane shows afterwards.
 *
 * Then the gate is turned on itself. A loop whose digest has been put out
 * must fail the scenarios that need to see the page, or the suite would be
 * proving nothing about the loop; and a scenario that cannot even be set up
 * must be reported as errored, so an outage in the bench is never read as a
 * regression in the loop, nor hidden inside its denominator.
 */

let postgres: TestPostgres;
let bench: EvalBench;

beforeAll(async () => {
  postgres = await startTestPostgres();
  bench = await startEvalBench({ connectionString: postgres.connectionString });
});

afterAll(async () => {
  await bench.stop();
  await postgres.stop();
});

const SCRIPTED = { model: { kind: 'scripted' } } as const;

describe('the starting suite, scripted', () => {
  it.each(SCENARIOS.map((entry) => [entry.id, entry] as const))('%s passes', async (_id, entry) => {
    const result = await runScenario(bench, entry, SCRIPTED);
    expect(result).toMatchObject({ id: entry.id, verdict: 'passed', violations: [] });
    expect(result.error).toBeUndefined();
    expect(entry.expect).toContain(result.actual);
    expect(result.durationMs).toBeGreaterThan(0);
    // The scripted model still bills: the row carries the cost of the run.
    expect(result.llmUsage?.calls).toBeGreaterThan(0);
  });

  it('names every outcome class and every hostile mode at least once', () => {
    const classes = new Set(SCENARIOS.flatMap((entry) => entry.expect));
    expect([...classes].sort()).toEqual([...OUTCOME_CLASSES].sort());
    const modes = new Set(SCENARIOS.map((entry) => entry.mode));
    expect(modes).toEqual(new Set(['normal', 'blocked', 'hard-blocked', 'redesign']));
    expect(new Set(SCENARIOS.map((entry) => entry.id)).size).toBe(SCENARIOS.length);
  });
});

describe('the gate turned on itself', () => {
  it('fails the named scenarios when the loop is degraded: a digest that shows nothing', async () => {
    const named = [scenario('gym-cancel'), scenario('store-price')];
    const results = await runScenarios(bench, named, {
      ...SCRIPTED,
      overrides: { limits: { maxElements: 0, maxRegions: 0 } },
    });
    expect(results.map((result) => result.verdict)).toEqual(['failed', 'failed']);
    expect(results.map((result) => result.actual)).toEqual(['failed', 'failed']);
    expect(results.every((result) => result.error === undefined)).toBe(true);
    // And the sites show why: the goals were never reached. The membership stands, no price was read.
    expect(results.map((result) => result.violations)).toEqual([
      ['the member is active, not cancelled'],
      ['the result does not report the price $49.00: null'],
    ]);
    expect(summarize(results)).toEqual({ total: 2, passed: 0, failed: 2, errored: 0, passRate: 0 });
  });

  it('reports a scenario that cannot be set up as errored, distinct from failed', async () => {
    const broken: Scenario = {
      ...scenario('store-price'),
      id: 'store-price-broken',
      setup: () => Promise.reject(new Error('the seed was refused')),
    };
    const results = await runScenarios(bench, [scenario('store-price'), broken], SCRIPTED);
    expect(results.map((result) => result.verdict)).toEqual(['passed', 'errored']);
    expect(results[1]?.error).toContain('the seed was refused');
    expect(results[1]?.actual).toBeUndefined();
    expect(summarize(results)).toEqual({ total: 2, passed: 1, failed: 0, errored: 1, passRate: 1 });
  });
});
