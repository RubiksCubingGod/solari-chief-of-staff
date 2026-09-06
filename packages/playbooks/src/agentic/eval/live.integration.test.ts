import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';
import { startTestPostgres, type TestPostgres } from '@chief-of-staff/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ANTHROPIC_KEY_VARIABLE, liveLlmSkipReason } from '../live.js';
import { REPORT_DIR_VARIABLE, createSpendMeter, nightlyReport, readBaseline, runUnderCap, spendCapFrom, type SpendMeter } from './nightly.js';
import type { ScenarioResult } from './outcome.js';
import { startEvalBench, type EvalBench } from './runner.js';
import { SCENARIOS } from './scenarios.js';

/**
 * The live evals: the starting suite against the real model, held to the
 * committed baseline. This is the drift detector - the scripted run beside it
 * proves the loop, and only a real model can show a prompt that stopped
 * working or a page that reads differently than we meant.
 *
 * One test per scenario, each recording its result whatever it says: a single
 * scenario's verdict is the report's business, and stopping the suite at the
 * first failure would leave the rest unmeasured. The last test is the gate,
 * and the only one that can fail: the report against the baseline, printed
 * for the log and written for the workflow to keep.
 *
 * Skipped without the opt-in and the key, with the reason in the suite's
 * name; `scripts/live-llm.mjs` supplies both, and refuses to run without a
 * key rather than letting this skip.
 */

const liveSkip = liveLlmSkipReason(process.env, 'the live evals');
const suiteName = liveSkip === undefined ? 'the live evals @live-llm' : `the live evals @live-llm — ${liveSkip}`;

/** One scenario of a real model reading real pages, with a person in between. */
const LIVE_TIMEOUT_MS = 8 * 60_000;

describe.skipIf(liveSkip !== undefined)(suiteName, () => {
  let postgres: TestPostgres;
  let bench: EvalBench;
  let meter: SpendMeter;
  let client: Anthropic;
  const results: ScenarioResult[] = [];

  beforeAll(async () => {
    meter = createSpendMeter(spendCapFrom(process.env));
    client = new Anthropic({ apiKey: process.env[ANTHROPIC_KEY_VARIABLE] ?? '' });
    postgres = await startTestPostgres();
    bench = await startEvalBench({ connectionString: postgres.connectionString });
  });

  afterAll(async () => {
    await bench.stop();
    await postgres.stop();
  });

  it.each(SCENARIOS.map((entry) => [entry.id, entry] as const))(
    '%s, recorded whatever it says',
    async (_id, entry) => {
      const result = await runUnderCap(bench, entry, { model: { kind: 'live', client }, timeoutMs: LIVE_TIMEOUT_MS }, meter);
      results.push(result);
      expect(result.id).toBe(entry.id);
      // What it cost, in the output, so the log carries a number beside every verdict.
      process.stdout.write(
        `live eval ${result.id}: ${result.verdict} after ${String(result.durationMs)}ms for $${(result.llmUsage?.costUsd ?? 0).toFixed(4)}\n`,
      );
    },
    LIVE_TIMEOUT_MS + 60_000,
  );

  it('stays at or above the committed baseline', () => {
    const report = nightlyReport(results, readBaseline(), meter);
    const text = `${report.lines.join('\n')}\n`;
    process.stdout.write(text);

    const directory = process.env[REPORT_DIR_VARIABLE];
    if (directory !== undefined && directory.trim() !== '') {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'report.txt'), text);
      writeFileSync(join(directory, 'baseline.candidate.json'), `${JSON.stringify(report.candidate, null, 2)}\n`);
    }

    expect(results).toHaveLength(SCENARIOS.length);
    expect(report.exitCode, text).toBe(0);
  });
});
