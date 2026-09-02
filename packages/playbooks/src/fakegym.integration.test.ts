import { randomUUID } from 'node:crypto';

import {
  isTerminalTaskStatus,
  scriptedUserIO,
  type ScriptedReply,
  type ScriptedUserIO,
  type StepEventPayload,
  type TransitionEventPayload,
} from '@chief-of-staff/core';
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
  type Task,
  type TaskLedger,
  type TaskTimeline,
} from '@chief-of-staff/db';
import { startTestPostgres, type TestPostgres } from '@chief-of-staff/db/testing';
import {
  startFakegymFixture,
  type FakegymControl,
  type FixtureHandle,
  type Member,
} from '@chief-of-staff/fixtures';
import { createLocalProvider, type BrowserProvider } from '@chief-of-staff/solari';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { CODE_QUESTION, CODE_RETRY_QUESTION, fakegymCancellation } from './fakegym/cancellation.js';
import { createPlaybookMission, createPlaybookRegistry, type CredentialSource } from './runner/index.js';

/**
 * The cancellation playbook against the fakegym fixture, driven the way
 * production drives it: a task in Postgres, the engine on a pg-boss worker, a
 * local Chromium behind the provider seam, and a person played from a script
 * whose only source for the confirmation code is the fixture's control plane.
 *
 * Every path that does not cancel asserts the member record afterwards, because
 * "the task failed" is only half the claim: the site must not have moved either.
 */

const MEMBER = { id: 'ada', email: 'ada@example.test', password: 'analytical-engine', name: 'Ada' } as const;

/** Two strings that can never be a fixture code, which is always `GYM-` and six digits. */
const WRONG_CODE = 'not-the-code';
const STILL_WRONG_CODE = 'still-not-it';

let postgres: TestPostgres;
let database: Database;
let gym: FixtureHandle<FakegymControl>;
let provider: BrowserProvider;
let userId: string;
const harnesses: JobHarness[] = [];

const gymHost = (): string => new URL(gym.url).host;
/** The same server on a host the allowlist does not name: where the redesigned site sends retention. */
const partner = (): string => gym.url.replace('127.0.0.1', 'localhost');

const member = (): Promise<Member> => gym.control.member(MEMBER.id);

beforeAll(async () => {
  [postgres, gym] = await Promise.all([startTestPostgres(), startFakegymFixture()]);
  await runMigrations(postgres.connectionString);
  database = createDatabase(postgres.connectionString);
  const [user] = await database.db
    .insert(users)
    .values({ email: `${randomUUID()}@example.test` })
    .returning();
  if (user === undefined) throw new Error('the user insert returned no row');
  userId = user.id;
  await database.db
    .insert(siteConnections)
    .values({ userId, siteDomain: gymHost(), solariProfileId: 'gym-profile' });
  await gym.control.seedMember(MEMBER);
  // Snapshot the member as the baseline `reset` restores, code included.
  await gym.control.seed({});
  provider = createLocalProvider();
});

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.stop();
  expect(provider.liveSessionIds()).toEqual([]);
  await gym.control.reset();
});

afterAll(async () => {
  await provider.dispose();
  await gym.stop();
  await database.close();
  await postgres.stop();
});

/** The member's password, from the test and nowhere in the database: the proof-only credential source. */
const memberPassword: CredentialSource = () =>
  Promise.resolve({ kind: 'password', username: MEMBER.email, password: MEMBER.password });

const wrongPassword: CredentialSource = () =>
  Promise.resolve({ kind: 'password', username: MEMBER.email, password: 'difference-engine' });

interface Worker {
  readonly ledger: TaskLedger;
  readonly io: ScriptedUserIO;
}

interface WorkerOptions {
  readonly script?: readonly ScriptedReply[];
  /** The member's password by default; `connection` leaves the runner to its own source, the connection's profile. */
  readonly credentials?: CredentialSource | 'connection';
}

/** A worker with the engine and the fakegym playbook on it, a scripted person on its answer sink, on its own pg-boss schema. */
async function startWorker(options: WorkerOptions = {}): Promise<Worker> {
  const harness = createJobHarness({
    connectionString: postgres.connectionString,
    schema: `pgboss_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    pollingIntervalSeconds: 0.5,
  });
  const ledger: TaskLedger = { db: database.db, harness };
  const io = scriptedUserIO(createUserAnswerSink(ledger), options.script ?? []);
  const registry = createPlaybookRegistry([fakegymCancellation({ origin: gym.url })]);
  const credentials = options.credentials ?? memberPassword;
  const mission = createPlaybookMission({
    db: database.db,
    provider,
    registry,
    ...(credentials === 'connection' ? {} : { credentials }),
  });
  await harness.start();
  await registerTaskEngine({ db: database.db, mission, userIO: io })(harness);
  harnesses.push(harness);
  return { ledger, io };
}

async function createTask(): Promise<Task> {
  const [task] = await database.db
    .insert(tasks)
    .values({ userId, kind: 'cancel', input: { site: 'fakegym' }, mode: 'playbook' })
    .returning();
  if (task === undefined) throw new Error('the task insert returned no row');
  return task;
}

async function settled(taskId: string, timeoutMs = 90_000): Promise<TaskTimeline> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const timeline = await readTaskTimeline(database.db, taskId);
    if (timeline === undefined) throw new Error(`task ${taskId} vanished`);
    if (isTerminalTaskStatus(timeline.task.status)) return timeline;
    if (Date.now() > deadline) {
      throw new Error(`task ${taskId} still ${timeline.task.status} after ${String(timeoutMs)}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function run(worker: Worker, task: Task): Promise<TaskTimeline> {
  await enqueueTaskRun(worker.ledger, task.id);
  return settled(task.id);
}

function trail(timeline: TaskTimeline): string[] {
  return timeline.events.map((event) => {
    if (event.type === 'transition') return `transition:${(event.payload as TransitionEventPayload).cause}`;
    if (event.type === 'step') return `step:${(event.payload as StepEventPayload).name}`;
    return event.type;
  });
}

function steps(timeline: TaskTimeline, name?: string): StepEventPayload[] {
  return timeline.events
    .filter((event) => event.type === 'step')
    .map((event) => event.payload as StepEventPayload)
    .filter((step) => name === undefined || step.name === name);
}

function asked(worker: Worker): string[] {
  return worker.io.asked.map((question) => question.question);
}

function lastTransition(timeline: TaskTimeline): TransitionEventPayload | undefined {
  return timeline.events
    .filter((event) => event.type === 'transition')
    .map((event) => event.payload as TransitionEventPayload)
    .at(-1);
}

/** One walk from a fresh session up to the step that needs the code. */
const WALK = [
  'step:browser_session',
  'step:login',
  'step:retention',
  'step:are-you-sure',
  'step:confirmation-code',
];
/** The task parked on a question, answered, and picked up again. */
const PARKED = ['ask_user', 'transition:asked', 'user_reply', 'transition:answered', 'transition:resumed'];
/** A run that never got past signing in. */
const STOPPED_AT_LOGIN = ['transition:started', 'step:browser_session', 'step:login'];

describe('the fakegym cancellation', () => {
  it('signs in, declines the offer, walks both are-you-sure steps, asks for the code, and cancels with it in a fresh session', async () => {
    const code = await gym.control.confirmationCode(MEMBER.id);
    const worker = await startWorker({ script: [{ kind: 'answer', reply: code }] });
    const timeline = await run(worker, await createTask());
    expect(timeline.task.status).toBe('succeeded');
    expect((await member()).status).toBe('cancelled');
    expect(trail(timeline)).toEqual(['transition:started', ...WALK, ...PARKED, ...WALK, 'transition:succeeded']);
    expect(asked(worker)).toEqual([CODE_QUESTION]);
    expect(timeline.task.playbookId).toBe('fakegym.cancel');
    expect(timeline.task.result).toMatchObject({ playbook: 'fakegym.cancel' });
    expect(steps(timeline, 'confirmation-code')).toEqual([
      { name: 'confirmation-code', outcome: 'ask', detail: { question: CODE_QUESTION } },
      { name: 'confirmation-code', outcome: 'done', detail: { status: 'cancelled', attempts: 1 } },
    ]);
    // Two sessions, both echoed as the local provider gives them: no recording to link.
    const echoes = steps(timeline, 'browser_session');
    expect(echoes).toHaveLength(2);
    for (const echo of echoes) {
      expect(echo.detail).toMatchObject({ provider: 'local', recording: false });
    }
    const ids = echoes.map((echo) => (echo.detail as { sessionId: string }).sessionId);
    expect(new Set(ids).size).toBe(2);
    expect(timeline.task.solariSessionId).toBe(ids[1]);
    expect(timeline.task.recordingUrl).toBeNull();
  });

  it('asks again when the site refuses the code once, and cancels with the second reply', async () => {
    const code = await gym.control.confirmationCode(MEMBER.id);
    const worker = await startWorker({
      script: [
        { kind: 'answer', reply: WRONG_CODE },
        { kind: 'answer', reply: code },
      ],
    });
    const timeline = await run(worker, await createTask());
    expect(timeline.task.status).toBe('succeeded');
    expect((await member()).status).toBe('cancelled');
    expect(asked(worker)).toEqual([CODE_QUESTION, CODE_RETRY_QUESTION]);
    expect(trail(timeline)).toEqual([
      'transition:started',
      ...WALK,
      ...PARKED,
      ...WALK,
      ...PARKED,
      ...WALK,
      'transition:succeeded',
    ]);
    expect(steps(timeline, 'confirmation-code').map((step) => step.outcome)).toEqual(['ask', 'ask', 'done']);
    expect(steps(timeline, 'confirmation-code').at(-1)?.detail).toEqual({ status: 'cancelled', attempts: 2 });
  });

  it('cancels the task when the person declines, and the membership stands', async () => {
    const worker = await startWorker({ script: [{ kind: 'decline' }] });
    const timeline = await run(worker, await createTask());
    expect(timeline.task.status).toBe('cancelled');
    expect(trail(timeline).at(-1)).toBe('transition:declined');
    expect(asked(worker)).toEqual([CODE_QUESTION]);
    expect(steps(timeline, 'browser_session')).toHaveLength(1);
    expect((await member()).status).toBe('active');
  });

  it('fails when the site refuses the credentials, before anything touches the membership', async () => {
    const worker = await startWorker({ credentials: wrongPassword });
    const timeline = await run(worker, await createTask());
    expect(timeline.task.status).toBe('failed');
    expect(trail(timeline)).toEqual([...STOPPED_AT_LOGIN, 'transition:error']);
    expect(lastTransition(timeline)).toMatchObject({
      cause: 'error',
      detail: { reason: 'login: fakegym refused the credentials (bad-credentials)' },
    });
    expect(asked(worker)).toEqual([]);
    expect((await member()).status).toBe('active');
  });

  it('fails after the site refuses the code twice, and the membership stands', async () => {
    const worker = await startWorker({
      script: [
        { kind: 'answer', reply: WRONG_CODE },
        { kind: 'answer', reply: STILL_WRONG_CODE },
      ],
    });
    const timeline = await run(worker, await createTask());
    expect(timeline.task.status).toBe('failed');
    expect(asked(worker)).toEqual([CODE_QUESTION, CODE_RETRY_QUESTION]);
    expect(trail(timeline)).toEqual([
      'transition:started',
      ...WALK,
      ...PARKED,
      ...WALK,
      ...PARKED,
      ...WALK,
      'transition:error',
    ]);
    expect(lastTransition(timeline)).toMatchObject({
      cause: 'error',
      detail: { reason: 'confirmation-code: fakegym refused the confirmation code twice' },
    });
    expect((await member()).status).toBe('active');
  });

  it('fails observably when the site serves its blocked shell, and the membership stands', async () => {
    await gym.control.setMode('hard-blocked');
    const worker = await startWorker();
    const timeline = await run(worker, await createTask());
    expect(timeline.task.status).toBe('failed');
    expect(trail(timeline)).toEqual([...STOPPED_AT_LOGIN, 'transition:error']);
    expect(lastTransition(timeline)).toMatchObject({
      cause: 'error',
      detail: { reason: 'login: fakegym is showing its blocked shell' },
    });
    expect(asked(worker)).toEqual([]);
    expect((await member()).status).toBe('active');
  });

  it('passes a soft block, which a real browser materialises, and still cancels', async () => {
    await gym.control.setMode('blocked');
    const code = await gym.control.confirmationCode(MEMBER.id);
    const worker = await startWorker({ script: [{ kind: 'answer', reply: code }] });
    const timeline = await run(worker, await createTask());
    expect(timeline.task.status).toBe('succeeded');
    expect((await member()).status).toBe('cancelled');
  });

  it('stops when the redesigned site hands retention to another host, and the membership stands', async () => {
    await gym.control.setMode('redesign');
    const worker = await startWorker();
    const timeline = await run(worker, await createTask());
    expect(timeline.task.status).toBe('failed');
    expect(trail(timeline)).toEqual([...STOPPED_AT_LOGIN, 'transition:violation']);
    expect(lastTransition(timeline)).toMatchObject({
      cause: 'violation',
      detail: {
        detail: {
          kind: 'allowlist',
          attemptedUrl: `${partner()}/partner/retention`,
          via: 'redirect',
          redirectedFrom: `${gym.url}/cancel/step-1`,
        },
      },
    });
    expect(asked(worker)).toEqual([]);
    expect((await member()).status).toBe('active');
  });

  it('fails when the site wants a full sign-in from a profile it no longer honours, naming the reconnect', async () => {
    const worker = await startWorker({ credentials: 'connection' });
    const timeline = await run(worker, await createTask());
    expect(timeline.task.status).toBe('failed');
    expect(trail(timeline)).toEqual([...STOPPED_AT_LOGIN, 'transition:error']);
    expect(lastTransition(timeline)).toMatchObject({
      cause: 'error',
      detail: { reason: 'login: fakegym asked for a full sign-in; reconnect this site' },
    });
    expect(asked(worker)).toEqual([]);
    expect((await member()).status).toBe('active');
  });
});
