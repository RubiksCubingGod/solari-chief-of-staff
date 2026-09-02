import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDatabase, type Database } from './client.js';
import { createJobHarness, type JobHarness, type RetryPolicy } from './jobs.js';
import { runMigrations } from './migrate.js';
import { tasks, users, type Task } from './schema.js';
import {
  reconcileTasks,
  registerTaskEngine,
  runTaskJob,
  type Mission,
  type MissionContext,
  type TaskEngineOptions,
} from './task-engine.js';
import {
  TASK_RUN_QUEUE,
  answerTask,
  enqueueTaskRun,
  pendingQuestion,
  readTaskTimeline,
  transitionTask,
  type TaskLedger,
  type TaskTimeline,
} from './task-ledger.js';
import { startTestPostgres, type TestPostgres } from './testing/postgres.js';

/**
 * The state machine the task-state-machine spec claims, proven over the real
 * substrate: a Postgres from the container ladder and a pg-boss worker that is
 * killed and restarted in the crash cases. Nothing here is mocked, because the
 * invariant under test is that the database is the only task state, and the
 * only way to show that is to lose the process and read the row.
 */

let postgres: TestPostgres;
let database: Database;
let userId: string;

interface Engine {
  readonly harness: JobHarness;
  readonly ledger: TaskLedger;
  readonly options: TaskEngineOptions;
  stop(options?: { graceful?: boolean }): Promise<void>;
}

const engines: Engine[] = [];

/**
 * What each test's tasks should do, keyed by task id. One mission serves every
 * engine, and a task no test scripted simply succeeds - so a queued row one
 * test left behind and a later engine's sweep picked up cannot disturb the
 * later test's counters.
 */
const behaviours = new Map<string, Mission>();
const mission: Mission = (context) =>
  (behaviours.get(context.task.id) ?? (() => Promise.resolve({ kind: 'succeeded' as const })))(context);

beforeAll(async () => {
  postgres = await startTestPostgres();
  await runMigrations(postgres.connectionString);
  database = createDatabase(postgres.connectionString);
  const [user] = await database.db
    .insert(users)
    .values({ email: `${randomUUID()}@example.test` })
    .returning();
  if (user === undefined) throw new Error('the user insert returned no row');
  userId = user.id;
});

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
});

afterAll(async () => {
  await database.close();
  await postgres.stop();
});

/**
 * A worker process: a harness with the engine registered on it. Each test gets
 * its own pg-boss schema, because a queue's retry policy is fixed when the
 * queue is created and the crash cases need different ones; a test that must
 * restart "the same" worker passes the schema of the one it killed.
 */
async function startEngine(
  options: {
    readonly retryPolicy?: RetryPolicy;
    readonly waitingUserTimeoutMs?: number;
    readonly schema?: string;
  } = {},
): Promise<Engine> {
  const schema = options.schema ?? `pgboss_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const harness = createJobHarness({
    connectionString: postgres.connectionString,
    schema,
    pollingIntervalSeconds: 0.5,
    ...(options.retryPolicy === undefined
      ? {}
      : { retryPolicy: options.retryPolicy }),
  });
  const engineOptions: TaskEngineOptions = {
    db: database.db,
    mission,
    ...(options.waitingUserTimeoutMs === undefined
      ? {}
      : { waitingUserTimeoutMs: options.waitingUserTimeoutMs }),
  };
  await harness.start();
  await registerTaskEngine(engineOptions)(harness);
  let stopped = false;
  const engine: Engine = {
    harness,
    ledger: { db: database.db, harness },
    options: engineOptions,
    async stop(stopOptions) {
      if (stopped) return;
      stopped = true;
      await harness.stop(stopOptions);
    },
  };
  engines.push(engine);
  return engine;
}

async function createTask(input: object = {}): Promise<Task> {
  const [task] = await database.db
    .insert(tasks)
    .values({ userId, kind: 'cancel', input, mode: 'playbook' })
    .returning();
  if (task === undefined) throw new Error('the task insert returned no row');
  return task;
}

async function readTask(taskId: string): Promise<Task> {
  const [task] = await database.db.select().from(tasks).where(eq(tasks.id, taskId));
  if (task === undefined) throw new Error(`task ${taskId} vanished`);
  return task;
}

function waitForStatus(taskId: string, status: Task['status']): Promise<Task> {
  return vi.waitFor(
    async () => {
      const task = await readTask(taskId);
      expect(task.status).toBe(status);
      return task;
    },
    { timeout: 30_000, interval: 100 },
  );
}

async function timelineOf(taskId: string): Promise<TaskTimeline> {
  const timeline = await readTaskTimeline(database.db, taskId);
  if (timeline === undefined) throw new Error(`task ${taskId} has no timeline`);
  return timeline;
}

/** The trail as a reader would say it aloud: the event type, and for the typed ones, why. */
function trail(timeline: TaskTimeline): string[] {
  return timeline.events.map((event) => {
    const payload = event.payload as { cause?: string; attempted?: string };
    if (event.type === 'transition') return `transition:${payload.cause ?? '?'}`;
    if (event.type === 'rejected') return `rejected:${payload.attempted ?? '?'}`;
    return event.type;
  });
}

async function enqueue(engine: Engine, taskId: string): Promise<string> {
  const outcome = await enqueueTaskRun(engine.ledger, taskId);
  if (!outcome.enqueued) throw new Error(`task ${taskId} was not queued: ${String(outcome.status)}`);
  return outcome.jobId;
}

/** A mission that never returns, so the only way out is the worker dying. */
function hang(): { mission: Mission; entered: Promise<void>; calls: () => number } {
  let calls = 0;
  let enter: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  return {
    calls: () => calls,
    entered,
    mission: () => {
      calls += 1;
      if (calls === 1) {
        enter();
        return new Promise(() => {});
      }
      return Promise.resolve({ kind: 'succeeded', result: { calls } });
    },
  };
}

describe('the task lifecycle', () => {
  it('runs a queued task through running to succeeded, writing the trail as it goes', async () => {
    const engine = await startEngine();
    const task = await createTask({ site: 'fakegym' });
    behaviours.set(task.id, async ({ step }) => {
      await step({ name: 'login', outcome: 'ok' });
      return { kind: 'succeeded', result: { cancelled: true } };
    });

    const jobId = await enqueue(engine, task.id);
    const done = await waitForStatus(task.id, 'succeeded');

    expect(done.result).toEqual({ cancelled: true });
    expect(done.finishedAt).not.toBeNull();
    expect(done.jobId).toBe(jobId);
    const timeline = await timelineOf(task.id);
    expect(trail(timeline)).toEqual(['transition:started', 'step', 'transition:succeeded']);
    const [started, step, succeeded] = timeline.events;
    expect(started?.payload).toEqual({ from: 'queued', to: 'running', cause: 'started', detail: { jobId } });
    expect(step?.payload).toEqual({ name: 'login', outcome: 'ok' });
    expect(succeeded?.payload).toEqual({ from: 'running', to: 'succeeded', cause: 'succeeded', detail: null });
    expect((await engine.harness.inspect(TASK_RUN_QUEUE, jobId))?.state).toBe('completed');
  });

  it('lands a mission that throws in failed with the error on the transition, and completes the job', async () => {
    const engine = await startEngine();
    const task = await createTask();
    behaviours.set(task.id, () => Promise.reject(new Error('the site returned 503')));

    const jobId = await enqueue(engine, task.id);
    const failed = await waitForStatus(task.id, 'failed');

    expect(failed.finishedAt).not.toBeNull();
    expect(failed.result).toBeNull();
    const timeline = await timelineOf(task.id);
    expect(trail(timeline)).toEqual(['transition:started', 'transition:error']);
    expect(timeline.events[1]?.payload).toEqual({
      from: 'running',
      to: 'failed',
      cause: 'error',
      detail: { reason: 'the site returned 503' },
    });
    // The failure belongs to the task, not the job: retrying the job would
    // only run the same mission into the same wall.
    expect((await engine.harness.inspect(TASK_RUN_QUEUE, jobId))?.state).toBe('completed');
  });

  it('lands a violation in failed under its own cause', async () => {
    const engine = await startEngine();
    const task = await createTask();
    behaviours.set(task.id, () =>
      Promise.resolve({
        kind: 'failed',
        cause: 'violation',
        reason: 'navigated off the allowlist',
        detail: { url: 'https://elsewhere.test/' },
      }),
    );

    await enqueue(engine, task.id);
    await waitForStatus(task.id, 'failed');

    const timeline = await timelineOf(task.id);
    expect(trail(timeline)).toEqual(['transition:started', 'transition:violation']);
    expect(timeline.events[1]?.payload).toEqual({
      from: 'running',
      to: 'failed',
      cause: 'violation',
      detail: { reason: 'navigated off the allowlist', detail: { url: 'https://elsewhere.test/' } },
    });
  });

  it('parks a task that asks, and answers it by re-running the mission with the reply in hand', async () => {
    const engine = await startEngine();
    const task = await createTask();
    const contexts: MissionContext[] = [];
    behaviours.set(task.id, (context) => {
      contexts.push(context);
      const [answer] = context.answers;
      return Promise.resolve(
        answer === undefined
          ? { kind: 'ask', question: 'What is the confirmation code?' }
          : { kind: 'succeeded', result: { code: answer.reply } },
      );
    });

    const firstJobId = await enqueue(engine, task.id);
    await waitForStatus(task.id, 'waiting_user');

    let timeline = await timelineOf(task.id);
    expect(trail(timeline)).toEqual(['transition:started', 'ask_user', 'transition:asked']);
    const question = pendingQuestion(timeline);
    if (question === undefined) throw new Error('no pending question');
    expect(question.question).toBe('What is the confirmation code?');
    expect(Date.parse(question.expiresAt)).toBeGreaterThan(Date.now());
    expect(timeline.events[2]?.payload).toEqual({
      from: 'running',
      to: 'waiting_user',
      cause: 'asked',
      detail: { questionId: question.questionId },
    });
    expect(contexts).toHaveLength(1);
    // The first job is finished: parking releases the worker, and with it
    // whatever browser the mission held.
    expect((await engine.harness.inspect(TASK_RUN_QUEUE, firstJobId))?.state).toBe('completed');

    const answered = await answerTask(engine.ledger, task.id, {
      questionId: question.questionId,
      reply: 'GYM-123456',
    });
    expect(answered.accepted).toBe(true);
    const done = await waitForStatus(task.id, 'succeeded');

    expect(done.result).toEqual({ code: 'GYM-123456' });
    expect(done.jobId).not.toBe(firstJobId);
    expect(contexts).toHaveLength(2);
    expect(contexts[1]).not.toBe(contexts[0]);
    expect(contexts[1]?.answers).toEqual([
      {
        questionId: question.questionId,
        question: 'What is the confirmation code?',
        reply: 'GYM-123456',
        answeredAt: expect.any(String) as string,
      },
    ]);
    timeline = await timelineOf(task.id);
    expect(trail(timeline)).toEqual([
      'transition:started',
      'ask_user',
      'transition:asked',
      'user_reply',
      'transition:answered',
      'transition:resumed',
      'transition:succeeded',
    ]);
    expect(timeline.events[3]?.payload).toEqual({
      questionId: question.questionId,
      reply: 'GYM-123456',
      answeredAt: expect.any(String) as string,
    });
  });

  it('rejects an illegal transition and records the rejection instead of the change', async () => {
    const engine = await startEngine();
    const task = await createTask();
    await enqueue(engine, task.id);
    const done = await waitForStatus(task.id, 'succeeded');
    // Stopped so its sweep cannot touch the queued task below mid-assertion.
    await engine.stop();

    expect(await answerTask(engine.ledger, task.id, { questionId: randomUUID(), reply: 'yes' })).toEqual({
      accepted: false,
      reason: 'not_waiting',
    });
    expect(await transitionTask(database.db, task.id, { cause: 'succeeded' })).toEqual({
      ok: false,
      status: 'succeeded',
    });
    expect(await transitionTask(database.db, task.id, { cause: 'started' })).toEqual({
      ok: false,
      status: 'succeeded',
    });

    expect(await readTask(task.id)).toEqual(done);
    const timeline = await timelineOf(task.id);
    expect(trail(timeline)).toEqual([
      'transition:started',
      'transition:succeeded',
      'rejected:answered',
      'rejected:succeeded',
      'rejected:started',
    ]);
    expect(timeline.events[3]?.payload).toEqual({
      attempted: 'succeeded',
      status: 'succeeded',
      reason: 'illegal',
      detail: null,
    });

    const queued = await createTask();
    expect(await transitionTask(database.db, queued.id, { cause: 'succeeded' })).toEqual({
      ok: false,
      status: 'queued',
    });
    expect((await readTask(queued.id)).status).toBe('queued');
    expect(trail(await timelineOf(queued.id))).toEqual(['rejected:succeeded']);

    expect(await transitionTask(database.db, randomUUID(), { cause: 'started' })).toEqual({
      ok: false,
      status: undefined,
    });
  });

  it('times out a question nobody answers, then refuses the late answer and records it', async () => {
    const engine = await startEngine({ waitingUserTimeoutMs: 1_500 });
    const task = await createTask();
    let calls = 0;
    behaviours.set(task.id, () => {
      calls += 1;
      return Promise.resolve({ kind: 'ask', question: 'Proceed with cancellation?' });
    });

    await enqueue(engine, task.id);
    await waitForStatus(task.id, 'waiting_user');
    const question = pendingQuestion(await timelineOf(task.id));
    if (question === undefined) throw new Error('no pending question');

    const failed = await waitForStatus(task.id, 'failed');
    expect(failed.finishedAt).not.toBeNull();
    let timeline = await timelineOf(task.id);
    expect(trail(timeline)).toEqual(['transition:started', 'ask_user', 'transition:asked', 'transition:timeout']);
    expect(timeline.events[3]?.payload).toEqual({
      from: 'waiting_user',
      to: 'failed',
      cause: 'timeout',
      detail: { questionId: question.questionId, expiresAt: question.expiresAt },
    });
    expect(pendingQuestion(timeline)).toBeUndefined();

    expect(await answerTask(engine.ledger, task.id, { questionId: question.questionId, reply: 'yes' })).toEqual({
      accepted: false,
      reason: 'not_waiting',
    });
    timeline = await timelineOf(task.id);
    expect(trail(timeline).at(-1)).toBe('rejected:answered');
    expect(timeline.events.at(-1)?.payload).toEqual({
      attempted: 'answered',
      status: 'failed',
      reason: 'not_waiting',
      detail: { questionId: question.questionId, reply: 'yes' },
    });
    expect(calls).toBe(1);
    expect((await readTask(task.id)).status).toBe('failed');
  });

  it('expires a question on the answer path when the deadline passed before the timer fired', async () => {
    const engine = await startEngine({ waitingUserTimeoutMs: 60_000 });
    const task = await createTask();
    behaviours.set(task.id, () => Promise.resolve({ kind: 'ask', question: 'Proceed?' }));

    await enqueue(engine, task.id);
    await waitForStatus(task.id, 'waiting_user');
    const question = pendingQuestion(await timelineOf(task.id));
    if (question === undefined) throw new Error('no pending question');

    const late = await answerTask(
      engine.ledger,
      task.id,
      { questionId: question.questionId, reply: 'yes' },
      new Date(Date.parse(question.expiresAt) + 1),
    );

    expect(late).toEqual({ accepted: false, reason: 'expired' });
    expect((await readTask(task.id)).status).toBe('failed');
    const timeline = await timelineOf(task.id);
    expect(trail(timeline)).toEqual([
      'transition:started',
      'ask_user',
      'transition:asked',
      'transition:timeout',
      'rejected:answered',
    ]);
    expect(timeline.events[4]?.payload).toMatchObject({ reason: 'expired', status: 'failed' });

    // An answer to a question that was never asked is refused even while waiting.
    const other = await createTask();
    behaviours.set(other.id, () => Promise.resolve({ kind: 'ask', question: 'Proceed?' }));
    await enqueue(engine, other.id);
    await waitForStatus(other.id, 'waiting_user');
    expect(await answerTask(engine.ledger, other.id, { questionId: randomUUID(), reply: 'yes' })).toEqual({
      accepted: false,
      reason: 'unknown_question',
    });
    expect((await readTask(other.id)).status).toBe('waiting_user');
    expect(trail(await timelineOf(other.id)).at(-1)).toBe('rejected:answered');
  });

  it(
    'survives a worker killed mid-mission: the retried job re-runs the mission to the same outcome',
    async () => {
      const retryOnce: RetryPolicy = { retryLimit: 1, retryDelaySeconds: 0 };
      const first = await startEngine({ retryPolicy: retryOnce });
      const task = await createTask();
      const hung = hang();
      behaviours.set(task.id, hung.mission);

      const jobId = await enqueue(first, task.id);
      await hung.entered;
      await first.stop({ graceful: false });

      // Between the crash and the restart the row says running, and that is
      // the truth: pg-boss has the job marked for retry, and nothing else does.
      expect((await readTask(task.id)).status).toBe('running');

      const second = await startEngine({ retryPolicy: retryOnce, schema: schemaOf(first) });
      const done = await waitForStatus(task.id, 'succeeded');

      expect(hung.calls()).toBe(2);
      expect(done.jobId).toBe(jobId);
      expect(done.result).toEqual({ calls: 2 });
      const timeline = await timelineOf(task.id);
      expect(trail(timeline)).toEqual(['transition:started', 'transition:retried', 'transition:succeeded']);
      expect(timeline.events[1]?.payload).toEqual({
        from: 'running',
        to: 'running',
        cause: 'retried',
        detail: { jobId },
      });
      expect((await second.harness.inspect(TASK_RUN_QUEUE, jobId))?.state).toBe('completed');
    },
    90_000,
  );

  it(
    'lands a task the crash orphaned in failed once no retry remains, rather than running forever',
    async () => {
      const noRetries: RetryPolicy = { retryLimit: 0, retryDelaySeconds: 0 };
      const first = await startEngine({ retryPolicy: noRetries });
      const task = await createTask();
      const hung = hang();
      behaviours.set(task.id, hung.mission);

      const jobId = await enqueue(first, task.id);
      await hung.entered;
      await first.stop({ graceful: false });
      expect((await readTask(task.id)).status).toBe('running');

      // The restarted worker sweeps on registration and finds a running task
      // whose job pg-boss gave up on.
      await startEngine({ retryPolicy: noRetries, schema: schemaOf(first) });
      const failed = await waitForStatus(task.id, 'failed');

      expect(hung.calls()).toBe(1);
      expect(failed.finishedAt).not.toBeNull();
      const timeline = await timelineOf(task.id);
      expect(trail(timeline)).toEqual(['transition:started', 'transition:orphaned']);
      expect(timeline.events[1]?.payload).toEqual({
        from: 'running',
        to: 'failed',
        cause: 'orphaned',
        detail: { jobId, jobState: 'failed' },
      });
    },
    90_000,
  );

  it('runs the mission once however many times the job is delivered or enqueued', async () => {
    const engine = await startEngine();
    const task = await createTask();
    let calls = 0;
    behaviours.set(task.id, () => {
      calls += 1;
      return Promise.resolve({ kind: 'succeeded' });
    });

    // Two enqueues before either is delivered: one runs, the other finds the
    // task already claimed by a different job and steps aside.
    const first = await enqueueTaskRun(engine.ledger, task.id);
    const second = await enqueueTaskRun(engine.ledger, task.id);
    expect(first.enqueued).toBe(true);
    await waitForStatus(task.id, 'succeeded');
    for (const outcome of [first, second]) {
      if (!outcome.enqueued) continue;
      await vi.waitFor(async () => {
        expect((await engine.harness.inspect(TASK_RUN_QUEUE, outcome.jobId))?.state).toBe('completed');
      }, { timeout: 20_000, interval: 100 });
    }
    expect(calls).toBe(1);

    // The same job delivered again after the fact: the task is settled, so the
    // handler has nothing to do and says nothing.
    if (!first.enqueued) throw new Error('unreachable');
    await runTaskJob(engine.ledger, engine.options, { taskId: task.id }, first.jobId);
    expect(calls).toBe(1);
    expect(trail(await timelineOf(task.id))).toEqual(['transition:started', 'transition:succeeded']);

    // And a settled task cannot be enqueued again at all.
    expect(await enqueueTaskRun(engine.ledger, task.id)).toEqual({ enqueued: false, status: 'succeeded' });
  });

  it('picks up a queued task nobody enqueued, which is how a task created over the API gets run', async () => {
    const engine = await startEngine();
    const task = await createTask();
    let calls = 0;
    behaviours.set(task.id, () => {
      calls += 1;
      return Promise.resolve({ kind: 'succeeded' });
    });

    const report = await reconcileTasks(engine.ledger);

    expect(report.requeued).toContain(task.id);
    await waitForStatus(task.id, 'succeeded');
    expect(calls).toBe(1);
    expect(trail(await timelineOf(task.id))).toEqual(['transition:started', 'transition:succeeded']);
  });
});

function schemaOf(engine: Engine): string {
  return engine.harness.schema;
}
