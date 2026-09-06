import { randomUUID } from 'node:crypto';

import type Anthropic from '@anthropic-ai/sdk';
import { isTerminalTaskStatus, scriptedUserIO, type ScriptedReply, type ScriptedUserIO } from '@chief-of-staff/core';
import {
  createDatabase,
  createJobHarness,
  createUserAnswerSink,
  enqueueTaskRun,
  readTaskTimeline,
  registerTaskEngine,
  runMigrations,
  siteConnections,
  tasks,
  users,
  type Database,
  type JobHarness,
  type TaskLedger,
  type TaskTimeline,
} from '@chief-of-staff/db';
import { startFakegymFixture, startFakestoreFixture } from '@chief-of-staff/fixtures';
import { createLocalProvider, type BrowserProvider } from '@chief-of-staff/solari';

import { createPlaybookMission, createPlaybookRegistry } from '../../runner/index.js';
import { createAgenticMission, type AgenticMissionOptions } from '../runner.js';
import { createScriptedModel } from '../testing/scripted-model.js';
import { classifyOutcome, endingReason, verdictOf, type ScenarioResult } from './outcome.js';
import { MEMBER, PRODUCT, type EvalSites, type Scenario, type SiteName } from './scenarios.js';
import { startTrapFixture } from './trap.js';

/**
 * The bench a scenario runs on, and the run itself.
 *
 * A run is the production path and nothing shorter: a task row, the engine
 * on a pg-boss worker, the registry with no playbook to claim the site so
 * it falls through to the agentic mission, a local Chromium under the
 * guardrails, and the fixture in the mode the scenario asked for. Only the
 * two ends are played from scripts - the person, always; the model, unless
 * the run is told to use a live one - so what an eval measures is the loop.
 *
 * A run never throws. Whatever the bench could not do - seed, start, settle
 * - comes back as an errored result, so a nightly job can tell an outage
 * from a regression and a suite can keep going past one broken scenario.
 */

export interface EvalBenchOptions {
  readonly connectionString: string;
  /** Run the migrations first. On by default; off for a database that already has them. */
  readonly migrate?: boolean;
  /** The browser provider to run on. A local Chromium unless given, disposed with the bench only when the bench made it. */
  readonly provider?: BrowserProvider;
}

export interface EvalBench {
  readonly database: Database;
  readonly connectionString: string;
  readonly provider: BrowserProvider;
  /** The person every task belongs to, connected to every site. */
  readonly userId: string;
  readonly sites: EvalSites;
  stop(): Promise<void>;
}

const SITE_NAMES: readonly SiteName[] = ['gym', 'store', 'trap'];

export async function startEvalBench(options: EvalBenchOptions): Promise<EvalBench> {
  const [gym, store, trap] = await Promise.all([startFakegymFixture(), startFakestoreFixture(), startTrapFixture()]);
  const sites: EvalSites = { gym, store, trap };
  const ownsProvider = options.provider === undefined;
  const provider = options.provider ?? createLocalProvider();
  let database: Database | undefined;
  try {
    if (options.migrate !== false) await runMigrations(options.connectionString);
    database = createDatabase(options.connectionString);
    const [user] = await database.db
      .insert(users)
      .values({ email: `eval-${randomUUID()}@example.test` })
      .returning();
    if (user === undefined) throw new Error('the user insert returned no row');
    await database.db.insert(siteConnections).values(
      SITE_NAMES.map((name) => ({
        userId: user.id,
        siteDomain: new URL(sites[name].url).host,
        solariProfileId: `eval-${name}`,
      })),
    );
    // The baselines every run's reset restores: the member with a code, the product on the shelf.
    await gym.control.seedMember(MEMBER);
    await gym.control.seed({});
    await store.control.seed({ products: [PRODUCT] });
    const ready = database;
    return {
      database: ready,
      connectionString: options.connectionString,
      provider,
      userId: user.id,
      sites,
      stop: async () => {
        if (ownsProvider) await provider.dispose();
        await Promise.all(SITE_NAMES.map((name) => sites[name].stop()));
        await ready.close();
      },
    };
  } catch (error) {
    if (ownsProvider) await provider.dispose();
    await Promise.all(SITE_NAMES.map((name) => sites[name].stop()));
    await database?.close();
    throw error;
  }
}

/** The model a run puts on the transport: the scenario's script, or a real client. */
export type ModelUnderTest = { readonly kind: 'scripted' } | { readonly kind: 'live'; readonly client: Anthropic };

export interface RunOptions {
  readonly model: ModelUnderTest;
  /** Runner options laid over the scenario's own: how a suite degrades the loop on purpose. */
  readonly overrides?: Partial<AgenticMissionOptions>;
  /** How long a task may take to settle. Two minutes unless given; a live model needs more. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_MS = 250;
/** Generous, because an eval runs beside the rest of the gate: a slow click is not what it measures. */
const ACTION_TIMEOUT_MS = 5_000;
const NAVIGATION_TIMEOUT_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** True once the task is parked on a question the script has no answer to: the run's ending. */
function parkedForGood(io: ScriptedUserIO, replies: readonly ScriptedReply[]): boolean {
  const asked = io.asked.length;
  return asked > 0 && (asked > replies.length || replies[asked - 1]?.kind === 'ignore');
}

/**
 * The task's timeline once it has settled: a terminal status, or parked on a
 * question nobody will answer. A task still running at the deadline is the
 * bench's failure, thrown for the caller to report as such.
 */
async function settle(
  bench: EvalBench,
  io: ScriptedUserIO,
  replies: readonly ScriptedReply[],
  taskId: string,
  timeoutMs: number,
): Promise<TaskTimeline> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const timeline = await readTaskTimeline(bench.database.db, taskId);
    if (timeline === undefined) throw new Error(`task ${taskId} vanished from the ledger`);
    if (isTerminalTaskStatus(timeline.task.status)) return timeline;
    if (timeline.task.status === 'waiting_user' && parkedForGood(io, replies)) {
      await io.settled();
      return timeline;
    }
    if (Date.now() > deadline) {
      throw new Error(`the task was still ${timeline.task.status} after ${String(timeoutMs)}ms`);
    }
    await sleep(POLL_MS);
  }
}

async function resetSites(sites: EvalSites): Promise<void> {
  await Promise.all(SITE_NAMES.map((name) => sites[name].control.reset()));
}

/** One scenario, on its own worker, from a bench reset to its baselines. Never throws. */
export async function runScenario(bench: EvalBench, scenario: Scenario, options: RunOptions): Promise<ScenarioResult> {
  const started = Date.now();
  const { db } = bench.database;
  const { provider, sites } = bench;
  let harness: JobHarness | undefined;
  try {
    await resetSites(sites);
    await scenario.setup(sites);
    const replies = await scenario.replies(sites);
    harness = createJobHarness({
      connectionString: bench.connectionString,
      schema: `pgboss_eval_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      pollingIntervalSeconds: 0.5,
    });
    const ledger: TaskLedger = { db, harness };
    const io = scriptedUserIO(createUserAnswerSink(ledger), replies);
    const client =
      options.model.kind === 'live' ? options.model.client : createScriptedModel(scenario.policy(sites)).client;
    const fallback = createAgenticMission({
      db,
      provider,
      client,
      actionTimeoutMs: ACTION_TIMEOUT_MS,
      navigationTimeoutMs: NAVIGATION_TIMEOUT_MS,
      ...(scenario.credentials === undefined ? {} : { credentials: scenario.credentials }),
      ...scenario.runner,
      ...options.overrides,
    });
    const mission = createPlaybookMission({
      db,
      provider,
      registry: createPlaybookRegistry([]),
      ...(scenario.credentials === undefined ? {} : { credentials: scenario.credentials }),
      fallback,
    });
    await harness.start();
    await registerTaskEngine({ db, mission, userIO: io })(harness);
    const [task] = await db
      .insert(tasks)
      .values({
        userId: bench.userId,
        kind: scenario.kind,
        input: { url: scenario.start(sites), goal: scenario.goal },
        mode: 'agentic',
      })
      .returning();
    if (task === undefined) throw new Error('the task insert returned no row');
    await enqueueTaskRun(ledger, task.id);
    const timeline = await settle(bench, io, replies, task.id, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const actual = classifyOutcome(timeline);
    if (actual === undefined) {
      throw new Error(`the task settled as ${timeline.task.status}, which no outcome class covers`);
    }
    const violations = [...(await scenario.verify(sites, timeline))];
    const leaked = provider.liveSessionIds();
    if (leaked.length > 0) {
      violations.push(`${String(leaked.length)} browser session(s) still open after the task settled`);
    }
    const reason = endingReason(timeline);
    return {
      id: scenario.id,
      verdict: verdictOf(scenario.expect, actual, violations),
      expected: scenario.expect,
      actual,
      ...(reason === undefined ? {} : { reason }),
      violations,
      durationMs: Date.now() - started,
      llmUsage: timeline.task.llmUsage,
    };
  } catch (error) {
    return {
      id: scenario.id,
      verdict: 'errored',
      expected: scenario.expect,
      violations: [],
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
      llmUsage: null,
    };
  } finally {
    await harness?.stop();
  }
}

/** The scenarios one after another on the one bench, every result kept whatever the others did. */
export async function runScenarios(
  bench: EvalBench,
  scenarios: readonly Scenario[],
  options: RunOptions,
): Promise<readonly ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const entry of scenarios) results.push(await runScenario(bench, entry, options));
  return results;
}
