import { randomUUID } from 'node:crypto';

import {
  scriptedUserIO,
  type ScriptedReply,
  type ScriptedUserIO,
  type UserAnswerSink,
  type UserIO,
  type UserQuestion,
} from '@chief-of-staff/core';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDatabase, type Database } from './client.js';
import { createJobHarness, type JobHarness } from './jobs.js';
import { runMigrations } from './migrate.js';
import { tasks, users, type Task } from './schema.js';
import { registerTaskEngine, type Mission } from './task-engine.js';
import {
  TASK_RUN_QUEUE,
  declineTask,
  enqueueTaskRun,
  pendingQuestion,
  readTaskTimeline,
  type TaskLedger,
  type TaskTimeline,
} from './task-ledger.js';
import { startTestPostgres, type TestPostgres } from './testing/postgres.js';
import { createUserAnswerSink } from './user-io.js';

/**
 * The waiting_user gate with a person on the far side of it, proven over the
 * real substrate: a pg-boss worker on Testcontainers Postgres and a UserIO
 * played from a script, answering through the same sink Telegram will use.
 * The task-engine suite proves the machine; this one proves the port - that
 * the question reaches the person as the ledger recorded it, and that what
 * they say comes back as a transition or a recorded refusal, never as state
 * that lives anywhere but the row.
 */

let postgres: TestPostgres;
let database: Database;
let userId: string;
const harnesses: JobHarness[] = [];

/** What each test's task does, keyed by task id; an unscripted task simply succeeds. */
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
  for (const harness of harnesses.splice(0)) await harness.stop();
});

afterAll(async () => {
  await database.close();
  await postgres.stop();
});

interface Worker<IO extends UserIO> {
  readonly ledger: TaskLedger;
  readonly sink: UserAnswerSink;
  readonly io: IO;
}

/**
 * A worker with the engine on it and `makeIO`'s person wired to its answer
 * sink. Each worker gets its own pg-boss schema, so the queues start empty.
 */
async function startWorker<IO extends UserIO>(
  makeIO: (sink: UserAnswerSink) => IO,
  options: { readonly waitingUserTimeoutMs?: number } = {},
): Promise<Worker<IO>> {
  const harness = createJobHarness({
    connectionString: postgres.connectionString,
    schema: `pgboss_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    pollingIntervalSeconds: 0.5,
  });
  const ledger: TaskLedger = { db: database.db, harness };
  const sink = createUserAnswerSink(ledger);
  const io = makeIO(sink);
  await harness.start();
  await registerTaskEngine({
    db: database.db,
    mission,
    userIO: io,
    ...(options.waitingUserTimeoutMs === undefined
      ? {}
      : { waitingUserTimeoutMs: options.waitingUserTimeoutMs }),
  })(harness);
  harnesses.push(harness);
  return { ledger, sink, io };
}

function scripted(script: readonly ScriptedReply[]): (sink: UserAnswerSink) => ScriptedUserIO {
  return (sink) => scriptedUserIO(sink, script);
}

/**
 * The same person behind a channel that takes `ms` to put the question in
 * front of them. The engine commits the question to the row and delivers it
 * second, so a slow channel is the honest shape of the gap between
 * `waiting_user` on the row and a question in the person's hands.
 */
function slowly<IO extends UserIO>(
  makeIO: (sink: UserAnswerSink) => IO,
  ms: number,
): (sink: UserAnswerSink) => IO {
  return (sink) => {
    const io = makeIO(sink);
    return {
      ...io,
      ask: (question: UserQuestion) =>
        new Promise<void>((resolve) => setTimeout(resolve, ms)).then(() => io.ask(question)),
    };
  };
}

/** A mission that asks once, then finishes with whatever it was told. */
function askOnce(question: string): Mission {
  return ({ answers }) => {
    const [answer] = answers;
    return Promise.resolve(
      answer === undefined
        ? { kind: 'ask', question }
        : { kind: 'succeeded', result: { reply: answer.reply } },
    );
  };
}

function counting(inner: Mission): { readonly mission: Mission; runs(): number } {
  let runs = 0;
  return {
    mission: (context) => {
      runs += 1;
      return inner(context);
    },
    runs: () => runs,
  };
}

async function createTask(): Promise<Task> {
  const [task] = await database.db
    .insert(tasks)
    .values({ userId, kind: 'cancel', input: { site: 'fakegym' }, mode: 'playbook' })
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

/**
 * The question once the person has it. `waiting_user` on the row means the
 * ledger has the question; the channel gets it a moment later, so a read of
 * the asked list waits for delivery rather than assuming it.
 */
function delivered(io: ScriptedUserIO): Promise<UserQuestion> {
  return vi.waitFor(
    () => {
      const [question] = io.asked;
      if (question === undefined) throw new Error('nothing was asked yet');
      return question;
    },
    { timeout: 10_000, interval: 50 },
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

async function enqueue(ledger: TaskLedger, taskId: string): Promise<string> {
  const outcome = await enqueueTaskRun(ledger, taskId);
  if (!outcome.enqueued) throw new Error(`task ${taskId} was not queued: ${String(outcome.status)}`);
  return outcome.jobId;
}

describe('the waiting_user gate behind the UserIO port', () => {
  it('hands the person the question the ledger recorded, and leaves the task parked until they speak', async () => {
    const worker = await startWorker(slowly(scripted([{ kind: 'ignore' }]), 300));
    const task = await createTask();
    const counted = counting(askOnce('What is the confirmation code?'));
    behaviours.set(task.id, counted.mission);

    const jobId = await enqueue(worker.ledger, task.id);
    await waitForStatus(task.id, 'waiting_user');
    const asked = await delivered(worker.io);
    await worker.io.settled();

    const timeline = await timelineOf(task.id);
    const question = pendingQuestion(timeline);
    if (question === undefined) throw new Error('no pending question');
    expect(question.question).toBe('What is the confirmation code?');
    expect(asked).toEqual({ taskId: task.id, userId, ...question });
    expect(worker.io.asked).toHaveLength(1);
    expect(trail(timeline)).toEqual(['transition:started', 'ask_user', 'transition:asked']);
    expect(counted.runs()).toBe(1);
    // Parking released the worker: the job is done, and nothing is holding a
    // browser open on the person's behalf while they think.
    expect((await worker.ledger.harness.inspect(TASK_RUN_QUEUE, jobId))?.state).toBe('completed');
    expect((await readTask(task.id)).status).toBe('waiting_user');
  });

  it('resumes the task with the scripted answer, through the same sink a channel would use', async () => {
    const worker = await startWorker(scripted([{ kind: 'answer', reply: 'GYM-123456' }]));
    const task = await createTask();
    const counted = counting(askOnce('What is the confirmation code?'));
    behaviours.set(task.id, counted.mission);

    await enqueue(worker.ledger, task.id);
    const done = await waitForStatus(task.id, 'succeeded');
    await worker.io.settled();

    expect(done.result).toEqual({ reply: 'GYM-123456' });
    expect(worker.io.outcomes).toEqual([{ accepted: true }]);
    expect(counted.runs()).toBe(2);
    const timeline = await timelineOf(task.id);
    expect(trail(timeline)).toEqual([
      'transition:started',
      'ask_user',
      'transition:asked',
      'user_reply',
      'transition:answered',
      'transition:resumed',
      'transition:succeeded',
    ]);
    const [question] = worker.io.asked;
    expect(timeline.events[3]?.payload).toEqual({
      questionId: question?.questionId,
      reply: 'GYM-123456',
      answeredAt: expect.any(String) as string,
    });
  });

  it('cancels the task when the person declines, and lets nothing run it again', async () => {
    const worker = await startWorker(scripted([{ kind: 'decline' }]));
    const task = await createTask();
    const counted = counting(askOnce('Cancel the membership for good?'));
    behaviours.set(task.id, counted.mission);

    await enqueue(worker.ledger, task.id);
    const cancelled = await waitForStatus(task.id, 'cancelled');
    await worker.io.settled();

    expect(cancelled.finishedAt).not.toBeNull();
    expect(cancelled.result).toBeNull();
    expect(worker.io.outcomes).toEqual([{ accepted: true }]);
    // The mission ran once: a decline is not an answer to resume on.
    expect(counted.runs()).toBe(1);
    const timeline = await timelineOf(task.id);
    expect(trail(timeline)).toEqual([
      'transition:started',
      'ask_user',
      'transition:asked',
      'transition:declined',
    ]);
    const [question] = worker.io.asked;
    expect(timeline.events[3]?.payload).toEqual({
      from: 'waiting_user',
      to: 'cancelled',
      cause: 'declined',
      detail: { questionId: question?.questionId },
    });
    // Cancelled is terminal: a stray enqueue finds nothing to run.
    expect(await enqueueTaskRun(worker.ledger, task.id)).toEqual({
      enqueued: false,
      status: 'cancelled',
    });
  });

  it('refuses and records an answer or a decline that arrives after the deadline has failed the task', async () => {
    const worker = await startWorker(scripted([{ kind: 'ignore' }]), {
      waitingUserTimeoutMs: 1_000,
    });
    const task = await createTask();
    const counted = counting(askOnce('Still there?'));
    behaviours.set(task.id, counted.mission);

    await enqueue(worker.ledger, task.id);
    await waitForStatus(task.id, 'waiting_user');
    const question = await delivered(worker.io);
    const failed = await waitForStatus(task.id, 'failed');
    expect(failed.finishedAt).not.toBeNull();

    expect(
      await worker.sink.resolve(task.id, question.questionId, {
        kind: 'answer',
        reply: 'GYM-123456',
      }),
    ).toEqual({ accepted: false, reason: 'not_waiting' });
    expect(await worker.sink.resolve(task.id, question.questionId, { kind: 'decline' })).toEqual({
      accepted: false,
      reason: 'not_waiting',
    });

    expect((await readTask(task.id)).status).toBe('failed');
    expect(counted.runs()).toBe(1);
    const timeline = await timelineOf(task.id);
    expect(trail(timeline)).toEqual([
      'transition:started',
      'ask_user',
      'transition:asked',
      'transition:timeout',
      'rejected:answered',
      'rejected:declined',
    ]);
    expect(timeline.events[4]?.payload).toEqual({
      attempted: 'answered',
      status: 'failed',
      reason: 'not_waiting',
      detail: { questionId: question.questionId, reply: 'GYM-123456' },
    });
    expect(timeline.events[5]?.payload).toEqual({
      attempted: 'declined',
      status: 'failed',
      reason: 'not_waiting',
      detail: { questionId: question.questionId },
    });
  });

  it('refuses a decline for a missing task or the wrong question, and expires one later than its deadline', async () => {
    const worker = await startWorker(scripted([{ kind: 'ignore' }]));
    const task = await createTask();
    behaviours.set(task.id, askOnce('Proceed?'));

    await enqueue(worker.ledger, task.id);
    await waitForStatus(task.id, 'waiting_user');
    const question = await delivered(worker.io);

    expect(
      await declineTask(database.db, randomUUID(), { questionId: question.questionId }),
    ).toEqual({ accepted: false, reason: 'not_found' });
    expect(await declineTask(database.db, task.id, { questionId: randomUUID() })).toEqual({
      accepted: false,
      reason: 'unknown_question',
    });
    expect((await readTask(task.id)).status).toBe('waiting_user');

    // The timer has not fired, but the clock says the deadline has passed:
    // the decline finds the question expired, and the trail says the deadline
    // went first.
    const afterDeadline = new Date(Date.parse(question.expiresAt) + 1);
    expect(
      await declineTask(database.db, task.id, { questionId: question.questionId }, afterDeadline),
    ).toEqual({ accepted: false, reason: 'expired' });
    expect((await readTask(task.id)).status).toBe('failed');
    const timeline = await timelineOf(task.id);
    expect(trail(timeline)).toEqual([
      'transition:started',
      'ask_user',
      'transition:asked',
      'rejected:declined',
      'transition:timeout',
      'rejected:declined',
    ]);
    expect(timeline.events[4]?.payload).toEqual({
      from: 'waiting_user',
      to: 'failed',
      cause: 'timeout',
      detail: { questionId: question.questionId, expiresAt: question.expiresAt },
    });
  });

  it('keeps the question and its deadline when delivery fails, and says so on the trail', async () => {
    const worker = await startWorker(() => ({
      ask: () => Promise.reject(new Error('telegram is down')),
    }));
    const task = await createTask();
    const counted = counting(askOnce('What is the confirmation code?'));
    behaviours.set(task.id, counted.mission);

    await enqueue(worker.ledger, task.id);
    await waitForStatus(task.id, 'waiting_user');
    const timeline = await vi.waitFor(
      async () => {
        const current = await timelineOf(task.id);
        expect(current.events).toHaveLength(4);
        return current;
      },
      { timeout: 10_000, interval: 100 },
    );

    const question = pendingQuestion(timeline);
    if (question === undefined) throw new Error('no pending question');
    expect(trail(timeline)).toEqual(['transition:started', 'ask_user', 'transition:asked', 'step']);
    expect(timeline.events[3]?.payload).toEqual({
      name: 'deliver_question',
      outcome: 'failed',
      detail: 'telegram is down',
    });

    // The question is still open to anyone who finds it another way - the
    // dashboard, say - and the answer resumes the task as usual.
    expect(
      await worker.sink.resolve(task.id, question.questionId, {
        kind: 'answer',
        reply: 'GYM-123456',
      }),
    ).toEqual({ accepted: true });
    const done = await waitForStatus(task.id, 'succeeded');
    expect(done.result).toEqual({ reply: 'GYM-123456' });
    expect(counted.runs()).toBe(2);
  });
});
