import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

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
import { mountInstanceRoutes, startFixture, type FixtureHandle } from '@chief-of-staff/fixtures';
import { createLocalProvider, type BrowserProvider } from '@chief-of-staff/solari';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { type AgenticBudgets } from './agentic/budget.js';
import { type ModelRetryPolicy } from './agentic/model.js';
import { createAgenticMission } from './agentic/runner.js';
import {
  createScriptedModel,
  declare,
  outage,
  refOf,
  say,
  script,
  useTool,
  useTools,
  type ModelPolicy,
  type ScriptedModel,
  type TokenUsage,
} from './agentic/testing/scripted-model.js';
import {
  createPlaybookMission,
  createPlaybookRegistry,
  definePlaybook,
  type CredentialSource,
} from './runner/index.js';

/**
 * The agentic runner on the real substrate: the s5 engine on a pg-boss worker
 * over Testcontainers Postgres, a local Chromium under the guardrails, a
 * person played from a script, and a model played from a script too - a
 * transport that answers `/v1/messages` with the tool calls a test wrote
 * down. Everything between the two scripts is real: the registry's
 * fallthrough, the loop, the budgets, the tools on the page, the cost on
 * the row, and the trail.
 */

interface ToyState {
  readonly logins: number;
  readonly confirmed: boolean;
}

interface ToyControl {
  state(): Promise<ToyState>;
  reset(): Promise<ToyState>;
}

const MEMBER = { email: 'toy@example.test', password: 'open-sesame' } as const;
const CODE = 'TOY-4242';
const SESSION_COOKIE = 'toy_session=member';
const CODE_QUESTION = 'What is the confirmation code the toy site sent you?';

function html(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

function form(request: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      raw += chunk;
    });
    request.on('end', () => {
      resolve(new URLSearchParams(raw));
    });
    request.on('error', reject);
  });
}

function signedIn(request: IncomingMessage): boolean {
  return (request.headers.cookie ?? '').split(';').some((cookie) => cookie.trim() === SESSION_COOKIE);
}

/** The s5 toy again: a login, a member page behind it, a confirmation form, and "outside" by another name. */
function startToy(): Promise<FixtureHandle<ToyControl>> {
  let logins = 0;
  let confirmed = false;
  return startFixture(
    'toy',
    (app) => {
      mountInstanceRoutes<ToyState>(app, {
        state: () => ({ logins, confirmed }),
        seed: () => undefined,
        reset: () => {
          logins = 0;
          confirmed = false;
        },
      });
      app.get('/login', (_request, response) => {
        response.type('html').send(
          html(
            'Sign in',
            [
              '<h1>Sign in</h1><form method="post" action="/login">',
              '<label>Email <input name="email" data-testid="email"></label>',
              '<label>Password <input name="password" type="password" data-testid="password"></label>',
              '<button type="submit" data-testid="sign-in">Sign in</button></form>',
            ].join(''),
          ),
        );
      });
      app.post('/login', async (request, response) => {
        const fields = await form(request);
        if (fields.get('email') !== MEMBER.email || fields.get('password') !== MEMBER.password) {
          response.status(401).type('html').send(html('Refused', '<p>Those details are not right</p>'));
          return;
        }
        logins += 1;
        response.setHeader('Set-Cookie', `${SESSION_COOKIE}; Path=/`);
        response.redirect(302, '/member');
      });
      app.get('/member', (request, response) => {
        if (!signedIn(request)) {
          response.redirect(302, '/login');
          return;
        }
        response.type('html').send(
          html(
            'Member',
            [
              `<h1>Member</h1><p>Signed in as ${MEMBER.email}</p>`,
              '<form method="post" action="/confirm"><label>Code <input name="code"></label>',
              '<button type="submit">Confirm</button></form>',
            ].join(''),
          ),
        );
      });
      app.post('/confirm', async (request, response) => {
        if (!signedIn(request)) {
          response.redirect(302, '/login');
          return;
        }
        const fields = await form(request);
        if (fields.get('code') !== CODE) {
          response.status(422).type('html').send(html('Wrong', '<p>That code is not right</p>'));
          return;
        }
        confirmed = true;
        response.type('html').send(html('Done', '<p>Confirmed</p>'));
      });
      app.get('/outside', (_request, response) => {
        response.type('html').send(html('Outside', '<h1>Outside the lane</h1>'));
      });
    },
    (request) => ({
      state: () => request<ToyState>('GET', '/__test/state'),
      reset: () => request<ToyState>('POST', '/__test/reset', {}),
    }),
  );
}

let postgres: TestPostgres;
let database: Database;
let toy: FixtureHandle<ToyControl>;
let provider: BrowserProvider;
let connectedId: string;
let strangerId: string;
let expiredId: string;
const harnesses: JobHarness[] = [];

const toyHost = (): string => new URL(toy.url).host;
const away = (): string => toy.url.replace('127.0.0.1', 'localhost');
const loginUrl = (): string => `${toy.url}/login`;

async function createUser(): Promise<string> {
  const [user] = await database.db
    .insert(users)
    .values({ email: `${randomUUID()}@example.test` })
    .returning();
  if (user === undefined) throw new Error('the user insert returned no row');
  return user.id;
}

beforeAll(async () => {
  [postgres, toy] = await Promise.all([startTestPostgres(), startToy()]);
  await runMigrations(postgres.connectionString);
  database = createDatabase(postgres.connectionString);
  [connectedId, strangerId, expiredId] = await Promise.all([createUser(), createUser(), createUser()]);
  await database.db.insert(siteConnections).values([
    { userId: connectedId, siteDomain: toyHost(), solariProfileId: 'toy-profile' },
    { userId: expiredId, siteDomain: toyHost(), solariProfileId: 'toy-profile-old', status: 'expired' },
  ]);
  provider = createLocalProvider();
});

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.stop();
  expect(provider.liveSessionIds()).toEqual([]);
  await toy.control.reset();
});

afterAll(async () => {
  await provider.dispose();
  await toy.stop();
  await database.close();
  await postgres.stop();
});

/** The toy's password, from the test and nowhere in the database: the proof-only credential source. */
const passwordCredentials: CredentialSource = () =>
  Promise.resolve({ kind: 'password', username: MEMBER.email, password: MEMBER.password });

/** A clock the test turns by hand, for the wall-time budget. */
interface Clock {
  now: number;
}

interface Worker {
  readonly ledger: TaskLedger;
  readonly io: ScriptedUserIO;
  readonly model: ScriptedModel;
  /** Every backoff the runner asked for, in order; none of them actually waited. */
  readonly sleeps: readonly number[];
  /** How many sessions the provider held at each ask. */
  readonly liveAtAsk: readonly number[];
}

interface WorkerOptions {
  readonly policy: ModelPolicy;
  readonly usage?: (turn: number) => Partial<TokenUsage>;
  readonly budgets?: Partial<AgenticBudgets>;
  readonly retry?: ModelRetryPolicy;
  readonly script?: readonly ScriptedReply[];
  readonly credentials?: CredentialSource | 'connection';
  readonly clock?: Clock;
}

/**
 * A worker with the engine on it, one toy playbook in the registry and the
 * agentic mission behind it as the fallback, a scripted person on the answer
 * sink and a scripted model on the transport, on its own pg-boss schema.
 */
async function startWorker(options: WorkerOptions): Promise<Worker> {
  const harness = createJobHarness({
    connectionString: postgres.connectionString,
    schema: `pgboss_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    pollingIntervalSeconds: 0.5,
  });
  const ledger: TaskLedger = { db: database.db, harness };
  const io = scriptedUserIO(createUserAnswerSink(ledger), options.script ?? []);
  const liveAtAsk: number[] = [];
  const userIO: UserIO = {
    ask: (question: UserQuestion) => {
      liveAtAsk.push(provider.liveSessionIds().length);
      return io.ask(question);
    },
  };
  const model = createScriptedModel(options.policy, options.usage === undefined ? {} : { usage: options.usage });
  const sleeps: number[] = [];
  const credentials = options.credentials ?? passwordCredentials;
  const credentialOption = credentials === 'connection' ? {} : { credentials };
  const clock = options.clock;
  const fallback = createAgenticMission({
    db: database.db,
    provider,
    client: model.client,
    ...credentialOption,
    ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
    ...(options.retry === undefined ? {} : { retry: options.retry }),
    ...(clock === undefined ? {} : { now: () => clock.now }),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    actionTimeoutMs: 1_500,
    navigationTimeoutMs: 30_000,
  });
  const registry = createPlaybookRegistry([
    definePlaybook({
      site: 'toy',
      action: 'custom',
      origin: toy.url,
      steps: [{ name: 'noop', run: () => Promise.resolve({ kind: 'done', detail: { ran: 'playbook' } }) }],
    }),
  ]);
  const mission = createPlaybookMission({ db: database.db, provider, registry, ...credentialOption, fallback });
  await harness.start();
  await registerTaskEngine({ db: database.db, mission, userIO })(harness);
  harnesses.push(harness);
  return { ledger, io, model, sleeps, liveAtAsk };
}

type TaskShape = Pick<Task, 'userId' | 'kind' | 'mode' | 'input'>;

/** A cancellation on the toy: no playbook claims that pair, so the registry falls through. */
async function createTask(overrides: Partial<TaskShape> = {}): Promise<Task> {
  const [task] = await database.db
    .insert(tasks)
    .values({
      userId: connectedId,
      kind: 'cancel',
      input: { site: 'toy', url: loginUrl() },
      mode: 'playbook',
      ...overrides,
    })
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

function lastTransition(timeline: TaskTimeline): TransitionEventPayload | undefined {
  return timeline.events
    .filter((event) => event.type === 'transition')
    .map((event) => event.payload as TransitionEventPayload)
    .at(-1);
}

/* The model's scripts. */

/**
 * Signs in through the tools, reading refs off the digests as it goes, and
 * declares what it saw. A fresh script per worker: a script counts its own
 * turns, and the fixture's URL is not known until the server is up.
 */
const signIn = (): ModelPolicy =>
  script(
  useTool('navigate', { url: loginUrl() }),
  (request) => useTool('type', { ref: refOf(request, 'Email'), text: MEMBER.email }),
  (request) => useTool('type', { ref: refOf(request, 'Password'), text: MEMBER.password }),
  (request) => useTool('click', { ref: refOf(request, 'Sign in') }),
  declare('succeeded', `The member page says: Signed in as ${MEMBER.email}`),
);

const readForever: ModelPolicy = (request) =>
  request.turn === 1 ? useTool('navigate', { url: loginUrl() }) : useTool('read', {});

describe('the registry fallthrough', () => {
  it('still runs a playbook that matches, without consulting the model', async () => {
    const worker = await startWorker({ policy: signIn() });
    const task = await createTask({ kind: 'custom', input: { site: 'toy' } });
    const timeline = await run(worker, task);
    expect(timeline.task.status).toBe('succeeded');
    expect(timeline.task.playbookId).toBe('toy.custom');
    expect(timeline.task.result).toEqual({ playbook: 'toy.custom', steps: [{ name: 'noop', detail: { ran: 'playbook' } }] });
    expect(worker.model.requests()).toEqual([]);
    expect(timeline.task.llmUsage).toBeNull();
  });

  it('falls through to the agentic mission when no playbook claims the pair, and says so on the trail', async () => {
    const worker = await startWorker({ policy: script(declare('failed', 'nothing to cancel here')) });
    const task = await createTask();
    const timeline = await run(worker, task);
    expect(timeline.task.status).toBe('failed');
    expect(timeline.task.playbookId).toBeNull();
    expect(steps(timeline, 'playbook')).toEqual([
      { name: 'playbook', outcome: 'unmatched', detail: { reason: 'no playbook for cancel on toy' } },
    ]);
  });

  it('goes straight to the agentic mission for a task in agentic mode, site or no site', async () => {
    const worker = await startWorker({ policy: script(declare('failed', 'nothing to cancel here')) });
    const task = await createTask({ mode: 'agentic', input: { url: loginUrl() } });
    const timeline = await run(worker, task);
    expect(timeline.task.status).toBe('failed');
    expect(steps(timeline, 'playbook')).toEqual([
      { name: 'playbook', outcome: 'unmatched', detail: { reason: 'the task asks for agentic mode' } },
    ]);
  });
});

describe('the agentic mission', () => {
  it('signs in through the tools and succeeds with evidence, the cost on the row and the password off the trail', async () => {
    const worker = await startWorker({
      policy: signIn(),
      usage: (turn) => ({ input_tokens: 1_000, output_tokens: 50, cache_read_input_tokens: turn === 1 ? 0 : 200 }),
    });
    const task = await createTask();
    const timeline = await run(worker, task);
    expect(timeline.task.status).toBe('succeeded');
    expect(timeline.task.result).toEqual({
      mode: 'agentic',
      status: 'succeeded',
      detail: `The member page says: Signed in as ${MEMBER.email}`,
    });
    expect(trail(timeline)).toEqual([
      'transition:started',
      'step:playbook',
      'step:browser_session',
      'step:llm',
      'step:tool:navigate',
      'step:llm',
      'step:tool:type',
      'step:llm',
      'step:tool:type',
      'step:llm',
      'step:tool:click',
      'step:llm',
      'step:tool:declare_outcome',
      'transition:succeeded',
    ]);
    expect(timeline.task.solariSessionId).not.toBeNull();
    expect(await toy.control.state()).toEqual({ logins: 1, confirmed: false });

    // Five calls at $5/$25 per million in and out, four of them reading 200 tokens from cache at $0.50.
    expect(timeline.task.llmUsage).toEqual({
      model: 'claude-opus-5',
      calls: 5,
      inputTokens: 5_000,
      outputTokens: 250,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 800,
      costUsd: 0.03165,
    });
    expect(steps(timeline, 'llm')[0]).toEqual({
      name: 'llm',
      outcome: 'ok',
      detail: {
        model: 'claude-opus-5',
        stopReason: 'tool_use',
        inputTokens: 1_000,
        outputTokens: 50,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        costUsd: 0.00625,
      },
    });

    const trailText = JSON.stringify(timeline.events);
    expect(trailText).not.toContain(MEMBER.password);
    expect(trailText).toContain('[redacted]');

    const [first] = worker.model.requests();
    expect(first?.toolNames).toEqual(['navigate', 'click', 'type', 'select', 'read', 'ask_user', 'declare_outcome']);
    expect(first?.body['model']).toBe('claude-opus-5');
    expect(first?.system).toContain('declare_outcome');
    expect(first?.brief).toContain(`Start at: ${loginUrl()}`);
    expect(first?.brief).toContain(`Allowed host: ${toyHost()}`);
    expect(first?.brief).toContain(`Credentials: sign in with email ${MEMBER.email} and password ${MEMBER.password}`);
    expect(first?.brief).not.toContain('Earlier in this task');
  });

  it('maps a declared failure onto failed with the model’s own words, and a blocked page onto a blocked failure', async () => {
    // One worker, two tasks: each task's conversation is its own, so each
    // gets its own script, chosen by which task the brief is for.
    const blockedScript = script(useTool('navigate', { url: loginUrl() }), declare('blocked', 'a captcha covers the page'));
    const failingScript = script(
      useTool('navigate', { url: loginUrl() }),
      declare('failed', 'the account has no plan to cancel'),
    );
    const worker = await startWorker({
      policy: (request) => (request.brief.includes('"which":"blocked"') ? blockedScript : failingScript)(request),
    });
    const failed = await run(worker, await createTask({ input: { url: loginUrl(), which: 'failed' } }));
    expect(failed.task.status).toBe('failed');
    expect(lastTransition(failed)).toMatchObject({
      cause: 'error',
      detail: { reason: 'the account has no plan to cancel', detail: { mode: 'agentic', status: 'failed' } },
    });
    expect(failed.task.llmUsage).toMatchObject({ calls: 2 });

    const blocked = await run(worker, await createTask({ input: { url: loginUrl(), which: 'blocked' } }));
    expect(blocked.task.status).toBe('failed');
    expect(lastTransition(blocked)).toMatchObject({
      cause: 'error',
      detail: { reason: 'blocked: a captcha covers the page', detail: { mode: 'agentic', status: 'blocked' } },
    });
  });

  it('parks on ask_user with the browser released, and resumes a fresh mission told the answer and what came before', async () => {
    const worker = await startWorker({
      policy: (request) => {
        if (request.brief.includes(CODE)) return declare('succeeded', `Entered ${CODE} and saw Confirmed`);
        return request.turn === 1 ? useTool('navigate', { url: loginUrl() }) : useTool('ask_user', { question: CODE_QUESTION });
      },
      script: [{ kind: 'answer', reply: CODE }],
    });
    const task = await createTask();
    const timeline = await run(worker, task);
    expect(timeline.task.status).toBe('succeeded');
    expect(worker.io.asked.map((question) => question.question)).toEqual([CODE_QUESTION]);
    expect(worker.liveAtAsk).toEqual([0]);
    expect(trail(timeline)).toEqual([
      'transition:started',
      'step:playbook',
      'step:browser_session',
      'step:llm',
      'step:tool:navigate',
      'step:llm',
      'step:tool:ask_user',
      'ask_user',
      'transition:asked',
      'user_reply',
      'transition:answered',
      'transition:resumed',
      'step:playbook',
      'step:browser_session',
      'step:llm',
      'step:tool:declare_outcome',
      'transition:succeeded',
    ]);

    const briefs = worker.model.requests().map((request) => request.brief);
    expect(briefs[0]).not.toContain('The person answered');
    const resumed = briefs.at(-1) ?? '';
    expect(resumed).toContain('The person answered');
    expect(resumed).toContain(`Q: ${CODE_QUESTION}`);
    expect(resumed).toContain(`A: ${CODE}`);
    expect(resumed).toContain('Earlier in this task');
    expect(resumed).toContain(`navigate ${loginUrl()}`);
    expect(resumed).toContain('ask_user');
    // The cost is the task's, across both missions.
    expect(timeline.task.llmUsage).toMatchObject({ calls: 3 });
  });

  it('strikes the password out of the outcome the model declares and the question it asks, as it does off the trail', async () => {
    const question = `Is ${MEMBER.password} still the password you want me to use?`;
    const worker = await startWorker({
      policy: (request) => {
        if (request.brief.includes('The person answered')) {
          return declare('succeeded', `Signed in with ${MEMBER.password} and saw the member page`);
        }
        return request.turn === 1 ? useTool('navigate', { url: loginUrl() }) : useTool('ask_user', { question });
      },
      script: [{ kind: 'answer', reply: 'yes' }],
    });
    const timeline = await run(worker, await createTask());
    expect(timeline.task.status).toBe('succeeded');
    expect(worker.io.asked.map((asked) => asked.question)).toEqual([
      'Is [redacted] still the password you want me to use?',
    ]);
    expect(timeline.task.result).toEqual({
      mode: 'agentic',
      status: 'succeeded',
      detail: 'Signed in with [redacted] and saw the member page',
    });
    expect(JSON.stringify(timeline.events)).not.toContain(MEMBER.password);
  });

  it('nudges a turn that used no tool, and that turn still spends a slot of the call budget', async () => {
    const worker = await startWorker({
      policy: script(say('Let me think about this.'), say('Still thinking.'), declare('succeeded', 'done')),
      budgets: { maxToolCalls: 2 },
    });
    const timeline = await run(worker, await createTask());
    expect(timeline.task.status).toBe('failed');
    expect(lastTransition(timeline)).toMatchObject({
      detail: { reason: 'budget exhausted: tool calls (2 of 2)', detail: { mode: 'agentic', status: 'budget' } },
    });
    const [, second] = worker.model.requests();
    expect(second?.lastText).toContain('declare_outcome');
    // Two silent turns spent the two the budget allowed; the declaration never got its turn.
    expect(worker.model.requests()).toHaveLength(2);
    expect(timeline.task.llmUsage).toMatchObject({ calls: 2 });
  });
});

describe('the budgets', () => {
  it('ends the mission failed when the tool-call budget is spent, with the cost so far on the row', async () => {
    const worker = await startWorker({ policy: readForever, budgets: { maxToolCalls: 3 } });
    const timeline = await run(worker, await createTask());
    expect(timeline.task.status).toBe('failed');
    expect(lastTransition(timeline)).toMatchObject({
      cause: 'error',
      detail: {
        reason: 'budget exhausted: tool calls (3 of 3)',
        detail: { mode: 'agentic', status: 'budget', axis: 'tool_calls', used: 3, limit: 3 },
      },
    });
    expect(steps(timeline, 'budget')).toEqual([
      { name: 'budget', outcome: 'exhausted', detail: { axis: 'tool_calls', used: 3, limit: 3 } },
    ]);
    expect(steps(timeline, 'tool:read')).toHaveLength(2);
    expect(timeline.task.llmUsage).toMatchObject({ calls: 3 });
    expect(timeline.task.llmUsage?.costUsd).toBeGreaterThan(0);
  });

  it('counts every tool call of a batched turn, and ends the mission when the batch spends the budget', async () => {
    const worker = await startWorker({
      policy: script(
        useTools(
          { name: 'navigate', input: { url: loginUrl() } },
          { name: 'read', input: {} },
          { name: 'read', input: {} },
          { name: 'read', input: {} },
        ),
        declare('succeeded', 'never reached'),
      ),
      budgets: { maxToolCalls: 3 },
    });
    const timeline = await run(worker, await createTask());
    expect(timeline.task.status).toBe('failed');
    expect(lastTransition(timeline)).toMatchObject({
      detail: {
        reason: 'budget exhausted: tool calls (3 of 3)',
        detail: { mode: 'agentic', status: 'budget', axis: 'tool_calls', used: 3, limit: 3 },
      },
    });
    // One turn asked for four tools; three ran, which is what the trail shows and what the event counts.
    expect(steps(timeline, 'tool:navigate')).toHaveLength(1);
    expect(steps(timeline, 'tool:read')).toHaveLength(2);
    expect(worker.model.requests()).toHaveLength(1);
    expect(timeline.task.llmUsage).toMatchObject({ calls: 1 });
  });

  it('ends the mission failed when the token budget is spent, before acting on the call that spent it', async () => {
    const worker = await startWorker({
      policy: readForever,
      usage: () => ({ input_tokens: 1_000, output_tokens: 50 }),
      budgets: { maxTokens: 2_500 },
    });
    const timeline = await run(worker, await createTask());
    expect(timeline.task.status).toBe('failed');
    expect(lastTransition(timeline)).toMatchObject({
      detail: {
        reason: 'budget exhausted: tokens (3150 of 2500)',
        detail: { axis: 'tokens', used: 3_150, limit: 2_500 },
      },
    });
    expect(steps(timeline, 'tool:read')).toHaveLength(1);
    expect(timeline.task.llmUsage).toEqual({
      model: 'claude-opus-5',
      calls: 3,
      inputTokens: 3_000,
      outputTokens: 150,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      costUsd: 0.01875,
    });
  });

  it('ends the mission failed when the wall clock runs out between two tools', async () => {
    const clock: Clock = { now: 1_000 };
    const worker = await startWorker({
      policy: (request) => {
        if (request.turn === 2) clock.now += 11_000;
        return readForever(request);
      },
      budgets: { maxWallMs: 10_000 },
      clock,
    });
    const timeline = await run(worker, await createTask());
    expect(timeline.task.status).toBe('failed');
    expect(lastTransition(timeline)).toMatchObject({
      detail: {
        reason: 'budget exhausted: wall time (11000 of 10000 ms)',
        detail: { axis: 'wall_time', used: 11_000, limit: 10_000 },
      },
    });
    expect(steps(timeline, 'tool:read')).toHaveLength(0);
    expect(timeline.task.llmUsage).toMatchObject({ calls: 2 });
  });
});

describe('the guardrails beneath the tools', () => {
  it('surfaces a violation to the model once, and ends the mission failed on the next', async () => {
    const worker = await startWorker({
      policy: script(useTool('navigate', { url: `${away()}/outside` }), useTool('read', {})),
    });
    const timeline = await run(worker, await createTask());
    expect(timeline.task.status).toBe('failed');
    expect(lastTransition(timeline)).toMatchObject({
      cause: 'violation',
      detail: { reason: `navigation to ${away()}/outside is outside the task's allowlist` },
    });
    // The model saw the first violation as a tool error; the second ended the
    // mission before anything more was shown to it.
    const results = worker.model.toolResults();
    expect(results.map((result) => result.isError)).toEqual([true]);
    expect(results[0]?.content).toContain('The guardrails stopped the browser');
    expect(results[0]?.content).toContain(`navigation to ${away()}/outside is outside the task's allowlist`);
    expect(worker.model.requests()).toHaveLength(2);
    expect(steps(timeline, 'tool:navigate')).toMatchObject([{ outcome: 'guardrail' }]);
    expect(steps(timeline, 'tool:read')).toMatchObject([{ outcome: 'guardrail' }]);
  });

  it('strikes the password out of the reason the guardrails word from the model’s own URL', async () => {
    const outside = `${away()}/outside?token=${MEMBER.password}`;
    const worker = await startWorker({
      policy: script(useTool('navigate', { url: outside }), useTool('navigate', { url: outside })),
    });
    const timeline = await run(worker, await createTask());
    expect(timeline.task.status).toBe('failed');
    expect(lastTransition(timeline)).toMatchObject({
      cause: 'violation',
      detail: { reason: `navigation to ${away()}/outside?token=[redacted] is outside the task's allowlist` },
    });
    expect(JSON.stringify(timeline.events)).not.toContain(MEMBER.password);
  });

  it('lets the model declare the outcome after a violation, since that needs no page', async () => {
    const worker = await startWorker({
      policy: script(
        useTool('navigate', { url: `${away()}/outside` }),
        declare('failed', 'the site sent me somewhere the task does not allow'),
      ),
    });
    const timeline = await run(worker, await createTask());
    expect(timeline.task.status).toBe('failed');
    expect(lastTransition(timeline)).toMatchObject({
      cause: 'error',
      detail: { reason: 'the site sent me somewhere the task does not allow' },
    });
  });
});

describe('malformed tool calls', () => {
  it('are re-asked with the validation error, bounded by the call budget', async () => {
    const worker = await startWorker({
      policy: () => useTool('click', { ref: 'button 3' }),
      budgets: { maxToolCalls: 3 },
    });
    const timeline = await run(worker, await createTask());
    expect(timeline.task.status).toBe('failed');
    expect(lastTransition(timeline)).toMatchObject({
      detail: { reason: 'budget exhausted: tool calls (3 of 3)' },
    });
    // Three turns, three bad clicks; the first two were answered with the
    // validation error, and the third used up the budget before a fourth turn.
    const results = worker.model.toolResults();
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.isError).toBe(true);
      expect(result.content).toContain('ref: must be a ref from the latest digest, like "e12"');
    }
    expect(worker.model.requests()).toHaveLength(3);
    expect(steps(timeline, 'tool:click')).toHaveLength(3);
  });

  it('tells the model when it names a tool that does not exist', async () => {
    const worker = await startWorker({
      policy: script(useTool('scroll', { by: 100 }), declare('failed', 'no way to scroll')),
    });
    const timeline = await run(worker, await createTask());
    expect(timeline.task.status).toBe('failed');
    expect(worker.model.toolResults()[0]).toMatchObject({
      isError: true,
      content: 'There is no tool named "scroll". The tools are: navigate, click, type, select, read, ask_user, declare_outcome.',
    });
    expect(steps(timeline, 'tool:scroll')).toMatchObject([{ outcome: 'unknown-tool' }]);
  });
});

describe('the model transport', () => {
  const retry: ModelRetryPolicy = { attempts: 3, baseDelayMs: 500 };

  it('retries an outage with backoff and goes on when the model answers', async () => {
    const worker = await startWorker({
      policy: script(outage(529), outage(529), useTool('navigate', { url: loginUrl() }), declare('succeeded', 'signed in page seen')),
      retry,
    });
    const timeline = await run(worker, await createTask());
    expect(timeline.task.status).toBe('succeeded');
    expect(worker.sleeps).toEqual([500, 1_000]);
    expect(worker.model.requests()).toHaveLength(4);
    expect(steps(timeline, 'llm').map((step) => step.outcome)).toEqual(['retry', 'retry', 'ok', 'ok']);
    expect(steps(timeline, 'llm')[0]).toMatchObject({ detail: { attempt: 1, status: 529, delayMs: 500 } });
    expect(timeline.task.llmUsage).toMatchObject({ calls: 2 });
  });

  it('fails the mission observably once the retries are spent', async () => {
    const worker = await startWorker({ policy: () => outage(529), retry });
    const timeline = await run(worker, await createTask());
    expect(timeline.task.status).toBe('failed');
    expect(worker.sleeps).toEqual([500, 1_000]);
    const transition = lastTransition(timeline);
    expect(transition).toMatchObject({
      cause: 'error',
      detail: { detail: { mode: 'agentic', status: 'error', attempts: 3, httpStatus: 529 } },
    });
    expect((transition?.detail as { reason: string }).reason).toMatch(/^the model was unavailable after 3 attempts: 529/);
    expect(steps(timeline, 'llm').map((step) => step.outcome)).toEqual(['retry', 'retry', 'error']);
    expect(timeline.task.llmUsage).toBeNull();
  });

  it('does not retry a request the API refused outright', async () => {
    const worker = await startWorker({ policy: () => outage(400), retry });
    const timeline = await run(worker, await createTask());
    expect(timeline.task.status).toBe('failed');
    expect(worker.sleeps).toEqual([]);
    expect(lastTransition(timeline)).toMatchObject({
      detail: { detail: { status: 'error', attempts: 1, httpStatus: 400 } },
    });
  });

  it('never retries past the wall-time budget', async () => {
    const clock: Clock = { now: 0 };
    const worker = await startWorker({
      policy: () => {
        clock.now += 4_000;
        return outage(529);
      },
      retry: { attempts: 5, baseDelayMs: 500 },
      budgets: { maxWallMs: 10_000 },
      clock,
    });
    const timeline = await run(worker, await createTask());
    expect(timeline.task.status).toBe('failed');
    // Three tries at four seconds each is past ten: the third is the last, and no backoff is scheduled beyond the deadline.
    expect(worker.model.requests()).toHaveLength(3);
    expect(worker.sleeps).toEqual([500, 1_000]);
    expect(lastTransition(timeline)).toMatchObject({
      detail: { reason: 'budget exhausted: wall time (12000 of 10000 ms)', detail: { axis: 'wall_time' } },
    });
  });
});

describe('what the mission refuses before opening a browser', () => {
  it('refuses a task whose input names no start URL', async () => {
    const worker = await startWorker({ policy: signIn() });
    const timeline = await run(worker, await createTask({ mode: 'agentic', input: { site: 'toy' } }));
    expect(timeline.task.status).toBe('failed');
    expect(trail(timeline)).toEqual(['transition:started', 'step:playbook', 'transition:error']);
    expect(lastTransition(timeline)).toMatchObject({
      detail: { reason: 'agentic mode needs input.url: an absolute http(s) URL to start at' },
    });
    expect(timeline.task.solariSessionId).toBeNull();
    expect(worker.model.requests()).toEqual([]);
  });

  it('refuses a connection that is not connected, like the playbook runner does', async () => {
    const worker = await startWorker({ policy: signIn() });
    const timeline = await run(worker, await createTask({ userId: expiredId }));
    expect(timeline.task.status).toBe('failed');
    expect(lastTransition(timeline)).toMatchObject({
      detail: { reason: `the site connection for ${toyHost()} is expired` },
    });
    expect(timeline.task.solariSessionId).toBeNull();
  });

  it('runs without a connection, telling the model it has no credentials', async () => {
    const worker = await startWorker({
      policy: script(useTool('navigate', { url: loginUrl() }), declare('failed', 'there is nothing to sign in with')),
    });
    const timeline = await run(worker, await createTask({ userId: strangerId }));
    expect(timeline.task.status).toBe('failed');
    expect(timeline.task.solariSessionId).not.toBeNull();
    const [first] = worker.model.requests();
    expect(first?.brief).toContain('Credentials: none');
    expect(first?.brief).not.toContain('password');
  });
});
