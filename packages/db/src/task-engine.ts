import type { StepEventPayload } from '@chief-of-staff/core';
import { inArray } from 'drizzle-orm';

import type { JobRegistration } from './jobs.js';
import { tasks, type Task } from './schema.js';
import {
  TASK_RUN_QUEUE,
  TASK_TIMEOUT_QUEUE,
  appendTaskEvent,
  askUser,
  claimTaskRun,
  enqueueTaskRun,
  expireQuestion,
  orphanTask,
  pendingQuestion,
  readTaskTimeline,
  transitionTask,
  type TaskAnswer,
  type TaskDatabase,
  type TaskLedger,
  type TaskRunJob,
  type TaskTimeoutJob,
} from './task-ledger.js';

/**
 * The worker side of the task state machine: what runs when a run job is
 * delivered, what runs when a question's deadline falls due, and the sweep
 * that finds tasks no job is going to come back for.
 *
 * The engine knows nothing about browsers or playbooks. It hands the mission a
 * task and its answers, and takes back one of three outcomes. A mission that
 * needs a person returns `ask` - returns, rather than waits - which is how
 * parking releases the browser: there is no handler left to hold one.
 */

export type MissionOutcome =
  | { readonly kind: 'succeeded'; readonly result?: unknown }
  | {
      readonly kind: 'failed';
      /** `violation` when a guardrail stopped the mission; `error` otherwise, and by default. */
      readonly cause?: 'error' | 'violation';
      readonly reason: string;
      readonly detail?: unknown;
    }
  | { readonly kind: 'ask'; readonly question: string };

export interface MissionContext {
  readonly task: Task;
  /** Every answer accepted so far, oldest first. Empty on a first run. */
  readonly answers: readonly TaskAnswer[];
  /** Puts a `step` event on the trail. A plain function, so a mission may destructure it. */
  readonly step: (payload: StepEventPayload) => Promise<void>;
}

/**
 * One attempt at the task, from the top. A resumed or retried task gets a
 * fresh invocation with the same task and more answers, never a continuation
 * of an earlier one: whatever the earlier one held died with its worker.
 */
export type Mission = (context: MissionContext) => Promise<MissionOutcome>;

export interface TaskEngineOptions {
  readonly db: TaskDatabase;
  readonly mission: Mission;
  /** How long a question stays open before the task fails by `timeout`. */
  readonly waitingUserTimeoutMs?: number;
  readonly now?: () => Date;
}

/**
 * A day. A question goes to a person's phone, and a person is allowed to be
 * asleep; a task that has waited longer than that is not going to be answered,
 * and should say so rather than sit in `waiting_user` forever.
 */
export const DEFAULT_WAITING_USER_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** The sweep's queue and cadence. Once a minute is fast enough for a phantom to be found. */
export const TASK_RECONCILE_QUEUE = 'tasks.reconcile';
export const TASK_RECONCILE_CRON = '* * * * *';

/** Job states pg-boss will not deliver again. */
const SETTLED_JOB_STATES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The run handler. Claim first, so a duplicate delivery is turned away before
 * any mission runs; then run the mission; then settle the task by what it
 * returned. A mission that throws is a mission that failed.
 */
export async function runTaskJob(
  ledger: TaskLedger,
  options: TaskEngineOptions,
  job: TaskRunJob,
  jobId: string,
): Promise<void> {
  const claim = await claimTaskRun(ledger.db, job.taskId, jobId);
  if (claim.kind !== 'run') return;

  const context: MissionContext = {
    task: claim.task,
    answers: claim.answers,
    step: async (payload) => {
      await appendTaskEvent(ledger.db, job.taskId, 'step', payload);
    },
  };
  let outcome: MissionOutcome;
  try {
    outcome = await options.mission(context);
  } catch (error: unknown) {
    outcome = { kind: 'failed', cause: 'error', reason: describe(error) };
  }
  await settle(ledger, options, job.taskId, outcome);
}

async function settle(
  ledger: TaskLedger,
  options: TaskEngineOptions,
  taskId: string,
  outcome: MissionOutcome,
): Promise<void> {
  switch (outcome.kind) {
    case 'succeeded':
      await transitionTask(ledger.db, taskId, { cause: 'succeeded', result: outcome.result ?? null });
      return;
    case 'failed':
      await transitionTask(ledger.db, taskId, {
        cause: outcome.cause ?? 'error',
        detail:
          outcome.detail === undefined
            ? { reason: outcome.reason }
            : { reason: outcome.reason, detail: outcome.detail },
      });
      return;
    case 'ask': {
      const now = (options.now ?? (() => new Date()))();
      const timeout = options.waitingUserTimeoutMs ?? DEFAULT_WAITING_USER_TIMEOUT_MS;
      await askUser(ledger, taskId, {
        question: outcome.question,
        expiresAt: new Date(now.getTime() + timeout),
      });
      return;
    }
  }
}

export interface ReconcileReport {
  /** Queued tasks that had no live job and were given one. */
  readonly requeued: string[];
  /** Running tasks whose job pg-boss will not deliver again, now failed. */
  readonly orphaned: string[];
  /** Parked tasks whose deadline had passed without the timer firing, now failed. */
  readonly expired: string[];
}

async function jobState(ledger: TaskLedger, task: Task): Promise<string | undefined> {
  if (task.jobId === null) return undefined;
  const record = await ledger.harness.inspect(TASK_RUN_QUEUE, task.jobId);
  return record?.state;
}

/**
 * Makes every open task's row agree with the queue. A queued task with no
 * job that will run it gets one; a running task whose job is settled is
 * failed as orphaned; a parked task past its deadline is failed by timeout.
 * Each write re-checks under the row lock, so a task that moved between the
 * read here and the write is left alone rather than argued with.
 */
export async function reconcileTasks(
  ledger: TaskLedger,
  now: Date = new Date(),
): Promise<ReconcileReport> {
  const report: ReconcileReport = { requeued: [], orphaned: [], expired: [] };
  const open = await ledger.db
    .select()
    .from(tasks)
    .where(inArray(tasks.status, ['queued', 'running', 'waiting_user']));

  for (const task of open) {
    if (task.status === 'queued') {
      const state = await jobState(ledger, task);
      if (state !== undefined && !SETTLED_JOB_STATES.has(state)) continue;
      if ((await enqueueTaskRun(ledger, task.id)).enqueued) report.requeued.push(task.id);
    } else if (task.status === 'running') {
      const state = await jobState(ledger, task);
      if (state !== undefined && !SETTLED_JOB_STATES.has(state)) continue;
      if (await orphanTask(ledger.db, task.id, task.jobId, state ?? 'missing')) {
        report.orphaned.push(task.id);
      }
    } else {
      const timeline = await readTaskTimeline(ledger.db, task.id);
      const question = timeline === undefined ? undefined : pendingQuestion(timeline);
      if (question === undefined || Date.parse(question.expiresAt) > now.getTime()) continue;
      if (await expireQuestion(ledger.db, task.id, question.questionId)) {
        report.expired.push(task.id);
      }
    }
  }
  return report;
}

/**
 * Registers the engine on a worker: the run and timeout handlers, the sweep
 * on its schedule, and one sweep right away - a worker that just started is
 * usually one that just died, and its orphans should not wait a minute.
 */
export function registerTaskEngine(options: TaskEngineOptions): JobRegistration {
  return async (harness) => {
    const ledger: TaskLedger = { db: options.db, harness };
    const now = options.now ?? (() => new Date());
    await harness.register<TaskRunJob>(TASK_RUN_QUEUE, (job, jobId) =>
      runTaskJob(ledger, options, job, jobId),
    );
    await harness.register<TaskTimeoutJob>(TASK_TIMEOUT_QUEUE, async (job) => {
      await expireQuestion(options.db, job.taskId, job.questionId);
    });
    await harness.register(TASK_RECONCILE_QUEUE, async () => {
      await reconcileTasks(ledger, now());
    });
    await harness.schedule(TASK_RECONCILE_QUEUE, TASK_RECONCILE_CRON);
    await reconcileTasks(ledger, now());
  };
}
