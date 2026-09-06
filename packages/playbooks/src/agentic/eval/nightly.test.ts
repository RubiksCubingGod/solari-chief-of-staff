import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  BASELINE_FILE,
  DEFAULT_SPEND_CAP_USD,
  REPORT_DIR_VARIABLE,
  SPEND_CAP_VARIABLE,
  createSpendMeter,
  nightlyReport,
  parseBaseline,
  readBaseline,
  spendCapFrom,
} from './nightly.js';
import type { Baseline, ScenarioResult } from './outcome.js';
import { SCENARIOS } from './scenarios.js';

/**
 * The ratchet's own rules, without a model or a browser: the baseline file
 * and what may be in it, the spend meter, the report the nightly leaves
 * behind and the exit code it decides, and the wiring - that the scripted
 * suite is in the gate every push runs, and that the nightly workflow runs
 * the live suite behind the key guard, under the cap.
 *
 * The baseline manipulation tests are the point. The same results exit 1 or
 * 0 depending only on what the committed file says, which is what proves
 * the gate reads the file rather than an opinion of its own; and since the
 * file only changes in a pull request, so does the bar.
 */

const LIVE_SUITE = 'packages/playbooks/src/agentic/eval/live.integration.test.ts';
const SCRIPTED_SUITE = 'packages/playbooks/src/agentic/eval/scripted.integration.test.ts';

const repositoryRoot = new URL('../../../../../', import.meta.url);
const fileAt = (relative: string): string =>
  readFileSync(new URL(relative, repositoryRoot), 'utf8').replaceAll('\r\n', '\n');

function result(id: string, verdict: ScenarioResult['verdict'], extra: Partial<ScenarioResult> = {}): ScenarioResult {
  return {
    id,
    verdict,
    expected: ['succeeded'],
    ...(verdict === 'errored' ? { error: 'the bench fell over' } : { actual: verdict === 'passed' ? 'succeeded' : 'failed' }),
    violations: [],
    durationMs: 1_500,
    llmUsage: null,
    ...extra,
  };
}

const cost = (costUsd: number): ScenarioResult['llmUsage'] => ({
  model: 'claude-opus-5',
  calls: 3,
  costUsd,
  inputTokens: 3_000,
  outputTokens: 150,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
});

describe('the committed baseline', () => {
  it('lists every scenario of the starting suite, and nothing else', () => {
    const listed = Object.keys(readBaseline().scenarios).sort();
    expect(listed).toEqual(SCENARIOS.map((entry) => entry.id).sort());
  });

  it('says in the file how it is changed: by hand, in a pull request', () => {
    expect(readBaseline().note).toMatch(/pull request/u);
    expect(fileAt(BASELINE_FILE)).toBe(JSON.stringify(readBaseline(), null, 2) + '\n');
  });

  it('refuses what is not a baseline, naming the problem', () => {
    expect(() => parseBaseline('[]')).toThrow(`${BASELINE_FILE} is not a baseline: expected an object with "scenarios"`);
    expect(() => parseBaseline('{"scenarios": 7}')).toThrow('expected an object with "scenarios"');
    expect(() => parseBaseline('{"scenarios": {"a": "maybe"}}')).toThrow(
      `${BASELINE_FILE} is not a baseline: scenario "a" is "maybe", not "pass" or "fail"`,
    );
    expect(() => parseBaseline('{"note": 3, "scenarios": {}}')).toThrow('"note" is not a string');
    expect(() => parseBaseline('not json')).toThrow(`${BASELINE_FILE} is not JSON`);
    expect(parseBaseline('{"scenarios": {"a": "pass", "b": "fail"}}')).toEqual({ scenarios: { a: 'pass', b: 'fail' } });
  });
});

describe('the spend meter', () => {
  it('adds up what the runs cost and is exhausted at the cap', () => {
    const meter = createSpendMeter(1);
    expect(meter.capUsd).toBe(1);
    expect(meter.spentUsd()).toBe(0);
    expect(meter.exhausted()).toBe(false);
    meter.charge(result('a', 'passed', { llmUsage: cost(0.4) }));
    expect(meter.spentUsd()).toBeCloseTo(0.4, 6);
    expect(meter.exhausted()).toBe(false);
    // A run the engine recorded no usage for cost nothing anybody knows of.
    meter.charge(result('b', 'errored'));
    expect(meter.spentUsd()).toBeCloseTo(0.4, 6);
    meter.charge(result('c', 'failed', { llmUsage: cost(0.6) }));
    expect(meter.spentUsd()).toBeCloseTo(1, 6);
    expect(meter.exhausted()).toBe(true);
  });

  it('refuses a cap that is not a number of dollars', () => {
    expect(() => createSpendMeter(-1)).toThrow('a spend cap is a number of dollars, zero or more, not -1');
    expect(() => createSpendMeter(Number.NaN)).toThrow('not NaN');
    expect(() => createSpendMeter(Number.POSITIVE_INFINITY)).toThrow('not Infinity');
    expect(createSpendMeter(0).exhausted()).toBe(true);
  });

  it('reads the cap from the environment, five dollars unless told otherwise', () => {
    expect(SPEND_CAP_VARIABLE).toBe('LIVE_EVAL_SPEND_CAP_USD');
    expect(DEFAULT_SPEND_CAP_USD).toBe(5);
    expect(spendCapFrom({})).toBe(5);
    expect(spendCapFrom({ [SPEND_CAP_VARIABLE]: ' ' })).toBe(5);
    expect(spendCapFrom({ [SPEND_CAP_VARIABLE]: '2.5' })).toBe(2.5);
    expect(() => spendCapFrom({ [SPEND_CAP_VARIABLE]: 'lots' })).toThrow(
      `${SPEND_CAP_VARIABLE} is "lots", not a number of dollars`,
    );
  });
});

describe('the nightly report', () => {
  const baseline: Baseline = { scenarios: { a: 'pass', b: 'pass', c: 'fail' } };
  const oneRegression = [result('a', 'passed'), result('b', 'failed', { reason: 'ended: the form was gone' }), result('c', 'failed')];

  it('exits 1 on a regression and names it', () => {
    const report = nightlyReport(oneRegression, baseline);
    expect(report.exitCode).toBe(1);
    expect(report.lines).toContain('regressions (passed at baseline, failed now): b');
    expect(report.lines.at(-1)).toBe('verdict: below baseline');
    expect(report.lines[0]).toBe('live evals: 3 run; 1 passed, 2 failed, 0 errored; pass rate 33% of 3 decided');
    expect(report.lines).toContain('  failed  b: expected succeeded, got failed: ended: the form was gone');
  });

  it('exits 0 for the same results once the file is lowered to match: the bar is the file, and only a PR moves it', () => {
    const lowered: Baseline = { scenarios: { ...baseline.scenarios, b: 'fail' } };
    const report = nightlyReport(oneRegression, lowered);
    expect(report.exitCode).toBe(0);
    expect(report.lines).toContain('regressions (passed at baseline, failed now): none');
    expect(report.lines.at(-1)).toBe('verdict: at or above baseline');
    // And raised, the same results fail again: c was allowed to fail, and now is not.
    const raised: Baseline = { scenarios: { ...lowered.scenarios, c: 'pass' } };
    expect(nightlyReport(oneRegression, raised).exitCode).toBe(1);
    expect(nightlyReport(oneRegression, raised).lines).toContain('regressions (passed at baseline, failed now): c');
  });

  it('reports an errored scenario apart from the failed ones, its baseline entry standing', () => {
    const results = [result('a', 'errored', { error: 'the API returned 529' }), result('b', 'passed'), result('c', 'failed')];
    const report = nightlyReport(results, baseline);
    expect(report.exitCode).toBe(0);
    expect(report.lines[0]).toBe('live evals: 3 run; 1 passed, 1 failed, 1 errored; pass rate 50% of 2 decided');
    expect(report.lines).toContain('  errored a: no verdict: the API returned 529');
    expect(report.lines).toContain('errored (no verdict, so the baseline entry stands; an outage is not a regression): a');
    expect(report.lines).toContain('regressions (passed at baseline, failed now): none');
    expect(report.candidate.scenarios['a']).toBe('pass');
  });

  it('refuses to report green when nothing came to a verdict', () => {
    const report = nightlyReport([result('a', 'errored'), result('b', 'errored'), result('c', 'errored')], baseline);
    expect(report.exitCode).toBe(1);
    expect(report.lines[0]).toBe('live evals: 3 run; 0 passed, 0 failed, 3 errored; no pass rate, since none came to a verdict');
    expect(report.lines.at(-1)).toBe('verdict: no verdict at all; not a regression, but not a pass either');
    expect(report.candidate).toEqual(baseline);
  });

  it('exits 1 when a listed scenario did not run', () => {
    const report = nightlyReport([result('a', 'passed'), result('b', 'passed')], baseline);
    expect(report.exitCode).toBe(1);
    expect(report.lines).toContain(`unrun (listed in ${BASELINE_FILE}, but did not run): c`);
    expect(report.candidate.scenarios['c']).toBe('fail');
  });

  it('lists improvements and new scenarios for a PR, never writing them into the file itself', () => {
    const results = [result('a', 'passed'), result('b', 'passed'), result('c', 'passed'), result('d', 'failed')];
    const report = nightlyReport(results, baseline);
    expect(report.exitCode).toBe(0);
    expect(report.lines).toContain(
      `improvements (failed at baseline, passed now; raise the bar by editing ${BASELINE_FILE} in a PR): c`,
    );
    expect(report.lines).toContain(`unlisted (ran, but ${BASELINE_FILE} has no entry; add one in a PR): d`);
    expect(report.candidate).toEqual({ scenarios: { a: 'pass', b: 'pass', c: 'pass', d: 'fail' } });
    expect(baseline.scenarios['c']).toBe('fail');
  });

  it('keeps the note, and shows what was spent against the cap', () => {
    const meter = createSpendMeter(5);
    const results = [
      result('a', 'passed', { llmUsage: cost(0.25), durationMs: 12_345, actual: 'succeeded' }),
      result('b', 'passed', { llmUsage: cost(0.15) }),
      result('c', 'failed', { violations: ['the member is active, not cancelled'] }),
    ];
    for (const entry of results) meter.charge(entry);
    const report = nightlyReport(results, { note: 'kept', ...baseline }, meter);
    expect(report.lines[1]).toBe('spent $0.4000 of the $5.00 cap');
    expect(report.lines).toContain('  passed  a: succeeded in 12.3s for $0.2500');
    expect(report.lines).toContain('  failed  c: expected succeeded, got failed; the member is active, not cancelled');
    expect(report.candidate.note).toBe('kept');
  });
});

describe('the wiring', () => {
  it('runs the scripted suite in the gate every push goes through', () => {
    const check = fileAt('.github/workflows/check.yml');
    expect(check).toMatch(/^on:\n\s+push:\n\s+pull_request:/mu);
    expect(check).toContain('run: pnpm check');
    // The scripted suite is an integration test like any other; the gate runs them all.
    expect(fileAt(SCRIPTED_SUITE)).toContain('the gate turned on itself');
    expect(fileAt('scripts/check.mjs')).toContain("'test'");
  });

  it('runs the live suite nightly, behind the key guard, under the cap, keeping the report', () => {
    const workflow = fileAt('.github/workflows/live-evals.yml');
    expect(workflow).toMatch(/^on:\n\s+schedule:\n\s+- cron: '\d+ \d+ \* \* \*'\n\s+workflow_dispatch:/mu);
    expect(workflow).toContain('ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}');
    expect(workflow).toContain("if: ${{ needs.guard.outputs.configured == 'true' }}");
    expect(workflow).toContain(`run: node scripts/live-llm.mjs ${LIVE_SUITE}`);
    expect(workflow).toContain(`${SPEND_CAP_VARIABLE}:`);
    expect(workflow).toContain(`${REPORT_DIR_VARIABLE}: live-evals`);
    expect(workflow).toContain('run: pnpm browsers --with-deps');
    expect(workflow).toMatch(/uses: actions\/upload-artifact@v4\n\s+if: always\(\)/u);
    expect(workflow).toContain('cancel-in-progress: false');
  });

  it('lets the live runner take the suites to run, and knows the evals by default', () => {
    const script = fileAt('scripts/live-llm.mjs');
    expect(script).toContain(`'${LIVE_SUITE}'`);
    expect(script).toContain('process.argv.slice(2)');
  });

  it('tells the reader how the baseline moves', () => {
    const readme = fileAt('README.md');
    expect(readme).toContain(`\`${BASELINE_FILE}\``);
    expect(readme).toContain('`scripts/live-llm.mjs`');
    expect(readme).toMatch(/pull request/u);
  });
});
