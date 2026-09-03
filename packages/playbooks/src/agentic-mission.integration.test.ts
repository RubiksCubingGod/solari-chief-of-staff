import { randomUUID } from 'node:crypto';

import Anthropic from '@anthropic-ai/sdk';
import {
  isTerminalTaskStatus,
  scriptedUserIO,
  type ScriptedReply,
  type ScriptedUserIO,
  type StepEventPayload,
  type TransitionEventPayload,
  type UserIO,
  type UserQuestion,
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

import { ANTHROPIC_KEY_VARIABLE, liveLlmSkipReason } from './agentic/live.js';
import { createAgenticMission } from './agentic/runner.js';
import {
  ask,
  createScriptedModel,
  declare,
  refOf,
  script,
  useTool,
  type ModelPolicy,
  type ModelRequest,
  type ScriptedModel,
} from './agentic/testing/scripted-model.js';
import { fakegymCancellation } from './fakegym/cancellation.js';
import {
  createPlaybookMission,
  createPlaybookRegistry,
  type CredentialSource,
} from './runner/index.js';

/**
 * The agentic mission path end to end: a cancellation on a site no playbook
 * claims, run the way production runs it. The task is a row in Postgres, the
 * engine is on a pg-boss worker, the registry falls through to the agentic
 * mission, the browser is a local Chromium under the s5 guardrails, the site
 * is the fakegym fixture with its retention detour, its two are-you-sure
 * pages and its emailed confirmation code, and the person is played from a
 * script whose only source for that code is the fixture's control plane.
 *
 * The model is played from a script too, except in the last block, where it
 * is the real one. A scripted model pins what the loop does with what the
 * model says; it cannot notice a page the model reads differently than we
 * meant. That is what the live smoke is for, and why it needs a deliberate
 * opt-in rather than a key that happens to be around.
 *
 * Every path that does not cancel asserts the member record afterwards,
 * because "the task failed" is only half the claim: the site must not have
 * moved either.
 */

const MEMBER = {
  id: 'ada',
  email: 'ada@example.test',
  password: 'analytical-engine',
  name: 'Ada',
} as const;

const CODE_QUESTION = 'Fakegym says it emailed you a confirmation code. What is the code?';
const CHALLENGE_QUESTION =
  'Fakegym is showing a "Checking your browser" page with nothing to sign in to. Can you open the site yourself and clear it, then tell me?';
const CANNOT_HELP = 'No, I cannot get past it either.';
const CANCELLED_EVIDENCE = 'Fakegym answered the confirmation form with status cancelled';

/** What the live model is told, in the words a person would use. */
const LIVE_GOAL =
  'Cancel my Fakegym membership. Sign in, go through every are-you-sure step the site puts in the way, and when it asks for the confirmation code it emailed me, ask me for the code - I will read it out. Report success only once the site says the membership is cancelled.';

let postgres: TestPostgres;
let database: Database;
let gym: FixtureHandle<FakegymControl>;
let provider: BrowserProvider;
let userId: string;
const harnesses: JobHarness[] = [];

const gymHost = (): string => new URL(gym.url).host;
const gymUrl = (path: string): string => `${gym.url}${path}`;
const loginUrl = (): string => gymUrl('/login');
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

interface Worker {
  readonly ledger: TaskLedger;
  readonly io: ScriptedUserIO;
  /** The scripted model, or nothing when the worker was given a real client. */
  readonly model: ScriptedModel | undefined;
  /** The membership's status at the moment of each question, oldest first. */
  readonly statusAtAsk: readonly string[];
  /** How many browser sessions the provider held at each question. */
  readonly liveAtAsk: readonly number[];
}

interface WorkerOptions {
  readonly policy?: ModelPolicy;
  readonly client?: Anthropic;
  readonly script?: readonly ScriptedReply[];
}

/**
 * A worker as the process ships it: the engine on its own pg-boss schema, the
 * fakegym playbook in the registry claiming `fakegym`, and the agentic
 * mission behind it for everything else, a scripted person on the answer
 * sink and, unless a real client is given, a scripted model on the transport.
 */
async function startWorker(options: WorkerOptions): Promise<Worker> {
  const harness = createJobHarness({
    connectionString: postgres.connectionString,
    schema: `pgboss_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    pollingIntervalSeconds: 0.5,
  });
  const ledger: TaskLedger = { db: database.db, harness };
  const io = scriptedUserIO(createUserAnswerSink(ledger), options.script ?? []);
  const statusAtAsk: string[] = [];
  const liveAtAsk: number[] = [];
  const userIO: UserIO = {
    ask: async (question: UserQuestion) => {
      statusAtAsk.push((await member()).status);
      liveAtAsk.push(provider.liveSessionIds().length);
      return io.ask(question);
    },
  };
  const model = options.policy === undefined ? undefined : createScriptedModel(options.policy);
  const client = options.client ?? model?.client;
  if (client === undefined) throw new Error('a worker needs a scripted policy or a real client');
  const fallback = createAgenticMission({
    db: database.db,
    provider,
    client,
    credentials: memberPassword,
    actionTimeoutMs: 1_500,
    navigationTimeoutMs: 30_000,
  });
  const registry = createPlaybookRegistry([fakegymCancellation({ origin: gym.url })]);
  const mission = createPlaybookMission({
    db: database.db,
    provider,
    registry,
    credentials: memberPassword,
    fallback,
  });
  await harness.start();
  await registerTaskEngine({ db: database.db, mission, userIO })(harness);
  harnesses.push(harness);
  return { ledger, io, model, statusAtAsk, liveAtAsk };
}

type TaskShape = Pick<Task, 'kind' | 'mode' | 'input'>;

/** A cancellation on "gym", a site the registry has no playbook for: the pair falls through to the agentic mission. */
async function createTask(overrides: Partial<TaskShape> = {}): Promise<Task> {
  const [task] = await database.db
    .insert(tasks)
    .values({
      userId,
      kind: 'cancel',
      input: { site: 'gym', url: loginUrl() },
      mode: 'playbook',
      ...overrides,
    })
    .returning();
  if (task === undefined) throw new Error('the task insert returned no row');
  return task;
}

async function settled(taskId: string, timeoutMs: number): Promise<TaskTimeline> {
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

async function run(worker: Worker, task: Task, timeoutMs = 120_000): Promise<TaskTimeline> {
  await enqueueTaskRun(worker.ledger, task.id);
  return settled(task.id, timeoutMs);
}

function transitions(timeline: TaskTimeline): string[] {
  return timeline.events
    .filter((event) => event.type === 'transition')
    .map((event) => `transition:${(event.payload as TransitionEventPayload).cause}`);
}

function steps(timeline: TaskTimeline, name?: string): StepEventPayload[] {
  return timeline.events
    .filter((event) => event.type === 'step')
    .map((event) => event.payload as StepEventPayload)
    .filter((step) => name === undefined || step.name === name);
}

function lastTransition(timeline: TaskTimeline): TransitionEventPayload | undefined {
  return timeline.events
    .filter((event) => event.type === 'transition')
    .map((event) => event.payload as TransitionEventPayload)
    .at(-1);
}

/** The text a `type` step recorded, which is what the trail would leak if it leaked. */
function typedTexts(timeline: TaskTimeline): unknown[] {
  return steps(timeline, 'tool:type').map((step) => {
    const detail = step.detail as { input?: { text?: unknown } } | undefined;
    return detail?.input?.text;
  });
}

/* The model's scripts. Every ref is read off the digest the model was last shown, never a selector. */

const signIn: readonly ModelPolicy[] = [
  () => useTool('navigate', { url: loginUrl() }),
  (request) => useTool('type', { ref: refOf(request, 'Email'), text: MEMBER.email }),
  (request) => useTool('type', { ref: refOf(request, 'Password'), text: MEMBER.password }),
  (request) => useTool('click', { ref: refOf(request, 'Sign in') }),
];

/**
 * From the member page to the confirmation form. Each step's form answers in
 * JSON with the next URL rather than with a page, so after every click the
 * model navigates to where the answer pointed.
 */
const throughTheSteps: readonly ModelPolicy[] = [
  (request) => useTool('click', { ref: refOf(request, 'Cancel membership') }),
  (request) => useTool('click', { ref: refOf(request, 'Continue cancelling') }),
  () => useTool('navigate', { url: gymUrl('/cancel/step-2') }),
  (request) => useTool('click', { ref: refOf(request, 'Continue cancelling') }),
  () => useTool('navigate', { url: gymUrl('/cancel/step-3') }),
  (request) => useTool('click', { ref: refOf(request, 'Continue cancelling') }),
  () => useTool('navigate', { url: gymUrl('/cancel/confirm') }),
];

/** The code, from the brief's record of what the person answered: the resumed mission is told it there and nowhere else. */
function codeFromBrief(request: ModelRequest): string {
  const match = /A: (GYM-\d{6})/.exec(request.brief);
  const code = match?.[1];
  if (code === undefined) throw new Error('the brief does not carry the confirmation code the person gave');
  return code;
}

/**
 * The whole cancellation: to the gate, ask, and - resumed in a fresh session
 * that has to sign in and walk the steps again, because the site keeps its
 * progress per session - through it.
 */
const cancellation = (): ModelPolicy =>
  script(
    ...signIn,
    ...throughTheSteps,
    ask(CODE_QUESTION),
    ...signIn,
    ...throughTheSteps,
    (request) => useTool('type', { ref: refOf(request, 'Confirmation code'), text: codeFromBrief(request) }),
    (request) => useTool('click', { ref: refOf(request, 'Cancel my membership') }),
    declare('succeeded', CANCELLED_EVIDENCE),
  );

/** One session's tool calls up to and including the gate, as they land on the trail. */
const TOOLS_TO_THE_GATE = [
  'tool:navigate',
  'tool:type',
  'tool:type',
  'tool:click',
  'tool:click',
  'tool:click',
  'tool:navigate',
  'tool:click',
  'tool:navigate',
  'tool:click',
  'tool:navigate',
];

describe('the whole cancellation', () => {
  it('walks the site through the tools, parks to ask for the code, and finishes on the reply with the member cancelled and the cost on the row', async () => {
    const code = await gym.control.confirmationCode(MEMBER.id);
    const worker = await startWorker({
      policy: cancellation(),
      script: [{ kind: 'answer', reply: code }],
    });
    const timeline = await run(worker, await createTask());

    expect(timeline.task.status).toBe('succeeded');
    expect(timeline.task.playbookId).toBeNull();
    expect(timeline.task.result).toEqual({ mode: 'agentic', status: 'succeeded', detail: CANCELLED_EVIDENCE });
    expect((await member()).status).toBe('cancelled');

    // The ask parked the task with the membership standing and the browser released.
    expect(worker.io.asked.map((question) => question.question)).toEqual([CODE_QUESTION]);
    expect(worker.statusAtAsk).toEqual(['active']);
    expect(worker.liveAtAsk).toEqual([0]);
    expect(transitions(timeline)).toEqual([
      'transition:started',
      'transition:asked',
      'transition:answered',
      'transition:resumed',
      'transition:succeeded',
    ]);

    // Every tool call is on the trail in order, and the password is not. Both
    // runs went through the registry, and both said why they fell through.
    const unmatched = { name: 'playbook', outcome: 'unmatched', detail: { reason: 'no playbook for cancel on gym' } };
    expect(steps(timeline, 'playbook')).toEqual([unmatched, unmatched]);
    expect(steps(timeline).map((step) => step.name).filter((name) => name.startsWith('tool:'))).toEqual([
      ...TOOLS_TO_THE_GATE,
      'tool:ask_user',
      ...TOOLS_TO_THE_GATE,
      'tool:type',
      'tool:click',
      'tool:declare_outcome',
    ]);
    expect(typedTexts(timeline)).toEqual([MEMBER.email, '[redacted]', MEMBER.email, '[redacted]', code]);
    expect(JSON.stringify(timeline.events)).not.toContain(MEMBER.password);

    // Every answered call was charged, both sessions onto the one row.
    expect(steps(timeline, 'llm')).toHaveLength(26);
    expect(timeline.task.llmUsage).toMatchObject({ model: 'claude-opus-5', calls: 26 });
    expect(timeline.task.llmUsage?.inputTokens).toBeGreaterThan(0);
    expect(timeline.task.llmUsage?.costUsd).toBeGreaterThan(0);

    // The resumed mission was told what the person said and what had been done before the pause.
    const requests = worker.model?.requests() ?? [];
    expect(requests).toHaveLength(26);
    const resumed = requests[12]?.brief ?? '';
    expect(resumed).toContain(`Q: ${CODE_QUESTION}`);
    expect(resumed).toContain(`A: ${code}`);
    expect(resumed).toContain('Earlier in this task, the tools were used like this:');
    expect(resumed).toContain(`ask_user -> ask: asked "${CODE_QUESTION}"`);
    // And the site's last word was shown to the model before it declared.
    expect(worker.model?.toolResults().at(-1)?.content).toContain('"status":"cancelled"');
  });
});

describe('the hostile modes', () => {
  it('ends blocked when the site serves its challenge to the browser, and the membership stands', async () => {
    await gym.control.setMode('hard-blocked');
    const worker = await startWorker({
      policy: script(
        () => useTool('navigate', { url: loginUrl() }),
        declare('blocked', 'the site shows a "Checking your browser" challenge and no sign-in form'),
      ),
    });
    const timeline = await run(worker, await createTask());
    expect(timeline.task.status).toBe('failed');
    expect(lastTransition(timeline)).toMatchObject({
      detail: {
        reason: 'blocked: the site shows a "Checking your browser" challenge and no sign-in form',
        detail: { mode: 'agentic', status: 'blocked' },
      },
    });
    expect(worker.model?.toolResults()[0]?.content).toContain('Checking your browser');
    expect(worker.model?.toolResults()[0]?.content).toContain('Enable JavaScript and cookies to continue');
    expect(steps(timeline, 'tool:declare_outcome')).toMatchObject([{ outcome: 'declared', detail: { status: 'blocked' } }]);
    expect((await member()).status).toBe('active');
    expect(await gym.control.mode()).toBe('hard-blocked');
  });

  it('may ask the person for help with the challenge first, and ends blocked when they cannot', async () => {
    await gym.control.setMode('hard-blocked');
    const worker = await startWorker({
      policy: script(
        () => useTool('navigate', { url: loginUrl() }),
        ask(CHALLENGE_QUESTION),
        () => useTool('navigate', { url: loginUrl() }),
        declare('blocked', 'the challenge is still there after asking for help'),
      ),
      script: [{ kind: 'answer', reply: CANNOT_HELP }],
    });
    const timeline = await run(worker, await createTask());
    expect(timeline.task.status).toBe('failed');
    expect(transitions(timeline)).toEqual([
      'transition:started',
      'transition:asked',
      'transition:answered',
      'transition:resumed',
      'transition:error',
    ]);
    expect(worker.io.asked.map((question) => question.question)).toEqual([CHALLENGE_QUESTION]);
    expect(worker.statusAtAsk).toEqual(['active']);
    expect(worker.model?.requests()[2]?.brief).toContain(`A: ${CANNOT_HELP}`);
    expect(lastTransition(timeline)).toMatchObject({
      detail: { detail: { mode: 'agentic', status: 'blocked' } },
    });
    expect((await member()).status).toBe('active');
  });

  it('sees through the blocked shell, as only a browser can, and cancels as on any other day', async () => {
    await gym.control.setMode('blocked');
    const code = await gym.control.confirmationCode(MEMBER.id);
    const worker = await startWorker({
      policy: cancellation(),
      script: [{ kind: 'answer', reply: code }],
    });
    const timeline = await run(worker, await createTask());
    expect(timeline.task.status).toBe('succeeded');
    expect((await member()).status).toBe('cancelled');
    // The shell keeps its title; the body under it is the sign-in form, which
    // the digest reads once the shell's script has swapped it in.
    const first = worker.model?.toolResults()[0]?.content ?? '';
    expect(first).toContain('"Email"');
    expect(first).toContain('"Sign in"');
    expect(first).not.toContain('Enable JavaScript and cookies to continue');
  });

  it('refuses to follow the redesigned site to its partner host, and the membership stands', async () => {
    await gym.control.setMode('redesign');
    const worker = await startWorker({
      policy: script(
        ...signIn,
        (request) => useTool('click', { ref: refOf(request, 'Cancel membership') }),
        (request) => useTool('click', { ref: refOf(request, 'Continue cancelling') }),
        declare('blocked', 'the site sent the browser to a partner host outside the task'),
      ),
    });
    const timeline = await run(worker, await createTask());
    expect(timeline.task.status).toBe('failed');
    expect(steps(timeline, 'tool:click').map((step) => step.outcome)).toEqual(['ok', 'ok', 'guardrail']);
    const shown = worker.model?.toolResults().at(-1);
    expect(shown?.isError).toBe(true);
    expect(shown?.content).toContain("outside the task's allowlist");
    expect(shown?.content).toContain('localhost');
    expect(lastTransition(timeline)).toMatchObject({
      detail: { detail: { mode: 'agentic', status: 'blocked' } },
    });
    expect((await member()).status).toBe('active');
  });
});

/* The live smoke. */

const liveSkip = liveLlmSkipReason(process.env, 'the live agentic smoke');

/** The reason rides in the suite name, so an ordinary run reports why it skipped. */
const liveSuiteName =
  liveSkip === undefined ? 'the live agentic smoke @live-llm' : `the live agentic smoke @live-llm — ${liveSkip}`;

/** Two sessions of a real model reading real pages, with a person in between. */
const LIVE_TIMEOUT_MS = 8 * 60_000;

describe.skipIf(liveSkip !== undefined)(liveSuiteName, () => {
  it(
    'cancels the membership with a real claude-opus-5, asking for the code on the way',
    async () => {
      const code = await gym.control.confirmationCode(MEMBER.id);
      const worker = await startWorker({
        client: new Anthropic({ apiKey: process.env[ANTHROPIC_KEY_VARIABLE] ?? '' }),
        script: [{ kind: 'answer', reply: code }],
      });
      const timeline = await run(worker, await createTask({ input: { site: 'gym', url: loginUrl(), goal: LIVE_GOAL } }), LIVE_TIMEOUT_MS);

      expect(timeline.task.status).toBe('succeeded');
      expect((await member()).status).toBe('cancelled');
      expect(worker.io.asked).toHaveLength(1);
      expect(worker.statusAtAsk).toEqual(['active']);
      expect(timeline.task.llmUsage?.calls).toBeGreaterThan(0);
      expect(timeline.task.llmUsage?.costUsd).toBeGreaterThan(0);
      expect(JSON.stringify(timeline.events)).not.toContain(MEMBER.password);
      // What it cost, in the output, so a nightly run leaves a number behind.
      process.stdout.write(`live agentic smoke: ${JSON.stringify(timeline.task.llmUsage)}\n`);
    },
    LIVE_TIMEOUT_MS + 60_000,
  );
});
