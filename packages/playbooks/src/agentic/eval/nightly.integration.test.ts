import { startTestPostgres, type TestPostgres } from '@chief-of-staff/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_SPEND_CAP_USD, createSpendMeter, nightlyReport, readBaseline, runUnderCap } from './nightly.js';
import type { ScenarioResult } from './outcome.js';
import { startEvalBench, type EvalBench } from './runner.js';
import { MEMBER, SCENARIOS, scenario } from './scenarios.js';

/**
 * The nightly's loop on the production path, with the model scripted: the
 * spend cap stopping a run partway and reporting the rest as not run, and
 * the whole starting suite going through under a cap it never reaches to a
 * report that stands at the committed baseline. The live suite runs this
 * same loop with a real model; what it adds is the model, not the mechanism.
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

describe('the spend cap', () => {
  it('runs until the cap is spent, then reports every remaining scenario as not run', async () => {
    // Less than one scripted run costs: the first scenario spends the cap.
    const meter = createSpendMeter(0.000_001);
    const results: ScenarioResult[] = [];
    for (const entry of [scenario('store-price'), scenario('gym-cancel')]) {
      results.push(await runUnderCap(bench, entry, SCRIPTED, meter));
    }
    expect(results.map((result) => result.verdict)).toEqual(['passed', 'errored']);
    const [ran, skipped] = results;
    expect(ran?.llmUsage?.costUsd).toBeGreaterThan(0);
    expect(meter.spentUsd()).toBe(ran?.llmUsage?.costUsd);
    expect(meter.exhausted()).toBe(true);
    expect(skipped).toMatchObject({ id: 'gym-cancel', verdict: 'errored', durationMs: 0, llmUsage: null, violations: [] });
    expect(skipped?.error).toBe(`not run: the spend cap of $0.00 was reached, with $${meter.spentUsd().toFixed(4)} spent`);
    // And the site shows it never ran: the member the scenario would have cancelled is still active.
    expect((await bench.sites.gym.control.member(MEMBER.id)).status).toBe('active');
  });

  it('lets the whole starting suite through under a cap it never reaches, to a report at the committed baseline', async () => {
    const meter = createSpendMeter(DEFAULT_SPEND_CAP_USD);
    const results: ScenarioResult[] = [];
    for (const entry of SCENARIOS) results.push(await runUnderCap(bench, entry, SCRIPTED, meter));
    expect(meter.spentUsd()).toBeGreaterThan(0);
    expect(meter.exhausted()).toBe(false);

    const baseline = readBaseline();
    const report = nightlyReport(results, baseline, meter);
    expect(report.exitCode, report.lines.join('\n')).toBe(0);
    expect(report.lines[0]).toBe(
      `live evals: ${String(SCENARIOS.length)} run; ${String(SCENARIOS.length)} passed, 0 failed, 0 errored; pass rate 100% of ${String(SCENARIOS.length)} decided`,
    );
    expect(report.lines[1]).toBe(`spent $${meter.spentUsd().toFixed(4)} of the $${DEFAULT_SPEND_CAP_USD.toFixed(2)} cap`);
    expect(report.lines.at(-1)).toBe('verdict: at or above baseline');
    // The scripted suite is the bar the file was written to: nothing to raise, nothing to add.
    expect(report.candidate).toEqual(baseline);
  });
});
