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

import {
  createPlaybookMission,
  createPlaybookRegistry,
  definePlaybook,
  type CredentialSource,
  type PlaybookStep,
} from './runner/index.js';

/**
 * The runner on the real substrate: the engine on a pg-boss worker over
 * Testcontainers Postgres, a local Chromium under the guardrails, a person
 * played from a script, and a toy site with a login, a member page, and a
 * confirmation form. The playbook is assembled per test from a handful of
 * steps, so each test says what its steps do and reads what the runner made
 * of them: the order on the trail, the row after, and the site's own count
 * of what was done to it.
 */

interface ToyState {
  readonly logins: number;
  readonly confirmed: boolean;
  readonly hits: readonly string[];
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

/** A form post's fields, read off the wire: the fixture app parses JSON, not forms. */
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

/**
 * A site with a login, a member page behind it, and a confirmation form
 * that wants a code the site sent elsewhere. Test-local rather than a fifth
 * fixture: the fakegym playbook has its own site, and this one's job is to
 * be somewhere a toy playbook can log in, ask, and be refused. "Outside" is
 * the same server reached by another name.
 */
function startToy(): Promise<FixtureHandle<ToyControl>> {
  let logins = 0;
  let confirmed = false;
  let hits: string[] = [];
  return startFixture(
    'toy',
    (app) => {
      app.use((request, _response, next) => {
        if (!request.path.startsWith('/__test')) hits.push(`${request.method} ${request.path}`);
        next();
      });
      mountInstanceRoutes<ToyState>(app, {
        state: () => ({ logins, confirmed, hits }),
        seed: () => undefined,
        reset: () => {
          logins = 0;
          confirmed = false;
          hits = [];
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
          response
            .status(401)
            .type('html')
            .send(html('Refused', '<p data-testid="refused">Those details are not right</p>'));
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
              `<p data-testid="who">Signed in as ${MEMBER.email}</p>`,
              '<form method="post" action="/confirm"><label>Code <input name="code" data-testid="code"></label>',
              '<button type="submit" data-testid="confirm">Confirm</button></form>',
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
          response.status(422).type('html').send(html('Wrong', '<p data-testid="wrong">That code is not right</p>'));
          return;
        }
        confirmed = true;
        response.type('html').send(html('Done', '<p data-testid="done">Confirmed</p>'));
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
/** Someone connected to the toy, someone who never was, and someone whose connection has expired. */
let connectedId: string;
let strangerId: string;
let expiredId: string;
const harnesses: JobHarness[] = [];

/** The toy's host, as the connection names it and the playbook's origin carries it. */
const toyHost = (): string => new URL(toy.url).host;
/** The toy's own server, under the name the allowlist does not admit. */
const away = (): string => toy.url.replace('127.0.0.1', 'localhost');

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

interface Worker {
  readonly ledger: TaskLedger;
  readonly io: ScriptedUserIO;
  /** How many sessions the provider held at each ask. */
  readonly liveAtAsk: readonly number[];
}

interface WorkerOptions {
  readonly script?: readonly ScriptedReply[];
  /** The toy's password by default; `connection` leaves the runner to its own source, the connection's profile. */
  readonly credentials?: CredentialSource | 'connection';
}

/** A worker with the engine and one toy playbook on it, a scripted person on its answer sink, on its own pg-boss schema. */
async function startWorker(steps: readonly PlaybookStep[], options: WorkerOptions = {}): Promise<Worker> {
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
  const registry = createPlaybookRegistry([
    definePlaybook({ site: 'toy', action: 'custom', origin: toy.url, steps }),
  ]);
  const credentials = options.credentials ?? passwordCredentials;
  const mission = createPlaybookMission({
    db: database.db,
    provider,
    registry,
    ...(credentials === 'connection' ? {} : { credentials }),
  });
  await harness.start();
  await registerTaskEngine({ db: database.db, mission, userIO })(harness);
  harnesses.push(harness);
  return { ledger, io, liveAtAsk };
}

type TaskShape = Pick<Task, 'userId' | 'kind' | 'mode' | 'input'>;

async function createTask(overrides: Partial<TaskShape> = {}): Promise<Task> {
  const [task] = await database.db
    .insert(tasks)
    .values({ userId: connectedId, kind: 'custom', input: { site: 'toy' }, mode: 'playbook', ...overrides })
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

function steps(timeline: TaskTimeline): StepEventPayload[] {
  return timeline.events
    .filter((event) => event.type === 'step')
    .map((event) => event.payload as StepEventPayload);
}

function sessions(timeline: TaskTimeline): StepEventPayload[] {
  return steps(timeline).filter((step) => step.name === 'browser_session');
}

function lastTransition(timeline: TaskTimeline): TransitionEventPayload | undefined {
  return timeline.events
    .filter((event) => event.type === 'transition')
    .map((event) => event.payload as TransitionEventPayload)
    .at(-1);
}

/* The steps the toy playbooks are assembled from. */

const login: PlaybookStep = {
  name: 'login',
  async run(page, { credential }) {
    if (credential?.kind !== 'password') return { kind: 'failed', reason: 'the toy site needs a password' };
    await page.goto(`${toy.url}/login`);
    await page.getByTestId('email').fill(credential.username);
    await page.getByTestId('password').fill(credential.password);
    await page.getByTestId('sign-in').click();
    await page.getByTestId('who').waitFor();
    return { kind: 'done' };
  },
};

const member: PlaybookStep = {
  name: 'member',
  async run(page) {
    await page.goto(`${toy.url}/member`);
    return { kind: 'done', detail: { who: await page.getByTestId('who').textContent() } };
  },
};

const confirm: PlaybookStep = {
  name: 'confirm',
  async run(page, { answerTo }) {
    const code = answerTo(CODE_QUESTION);
    if (code === undefined) return { kind: 'ask', question: CODE_QUESTION };
    await page.goto(`${toy.url}/member`);
    await page.getByTestId('code').fill(code);
    await page.getByTestId('confirm').click();
    await page.getByTestId('done').waitFor();
    return { kind: 'done', detail: { confirmed: true } };
  },
};

const refuse: PlaybookStep = {
  name: 'refuse',
  run: () => Promise.resolve({ kind: 'failed', reason: 'not today', detail: { because: 'testing' } }),
};

const explode: PlaybookStep = {
  name: 'explode',
  run: () => Promise.reject(new Error('the page fell over')),
};

const wander: PlaybookStep = {
  name: 'wander',
  async run(page) {
    await page.goto(`${away()}/outside`);
    return { kind: 'done' };
  },
};

const probe: PlaybookStep = {
  name: 'probe',
  run: (_page, { connection, credential, input }) =>
    Promise.resolve({ kind: 'done', detail: { domain: connection?.siteDomain, credential, input } }),
};

describe('the runner', () => {
  it('runs the steps in order on one guarded session and keeps what they produced', async () => {
    const worker = await startWorker([login, member]);
    const task = await createTask();
    const timeline = await run(worker, task);
    expect(timeline.task.status).toBe('succeeded');
    expect(trail(timeline)).toEqual([
      'transition:started',
      'step:browser_session',
      'step:login',
      'step:member',
      'transition:succeeded',
    ]);
    expect(timeline.task.playbookId).toBe('toy.custom');
    expect(timeline.task.solariSessionId).not.toBeNull();
    expect(timeline.task.result).toEqual({
      playbook: 'toy.custom',
      steps: [{ name: 'login' }, { name: 'member', detail: { who: `Signed in as ${MEMBER.email}` } }],
    });
    expect(steps(timeline).slice(1)).toEqual([
      { name: 'login', outcome: 'done' },
      { name: 'member', outcome: 'done', detail: { who: `Signed in as ${MEMBER.email}` } },
    ]);
    expect(await toy.control.state()).toMatchObject({ logins: 1, confirmed: false });
  });

  it('parks a step that asks, and resumes it with the reply in a fresh session', async () => {
    const worker = await startWorker([login, confirm], { script: [{ kind: 'answer', reply: CODE }] });
    const task = await createTask();
    const timeline = await run(worker, task);
    expect(timeline.task.status).toBe('succeeded');
    expect(trail(timeline)).toEqual([
      'transition:started',
      'step:browser_session',
      'step:login',
      'step:confirm',
      'ask_user',
      'transition:asked',
      'user_reply',
      'transition:answered',
      'transition:resumed',
      'step:browser_session',
      'step:login',
      'step:confirm',
      'transition:succeeded',
    ]);
    expect(worker.io.asked.map((question) => question.question)).toEqual([CODE_QUESTION]);
    // The session was released before the person was asked: nothing waits in a browser.
    expect(worker.liveAtAsk).toEqual([0]);
    const ids = sessions(timeline).map((session) => (session.detail as { sessionId: string }).sessionId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(steps(timeline).filter((step) => step.name === 'confirm')).toEqual([
      { name: 'confirm', outcome: 'ask', detail: { question: CODE_QUESTION } },
      { name: 'confirm', outcome: 'done', detail: { confirmed: true } },
    ]);
    expect(await toy.control.state()).toMatchObject({ logins: 2, confirmed: true });
  });

  it('cancels the task when the person declines, leaving the site as it was', async () => {
    const worker = await startWorker([login, confirm], { script: [{ kind: 'decline' }] });
    const task = await createTask();
    const timeline = await run(worker, task);
    expect(timeline.task.status).toBe('cancelled');
    expect(trail(timeline).at(-1)).toBe('transition:declined');
    expect(sessions(timeline)).toHaveLength(1);
    expect(await toy.control.state()).toMatchObject({ logins: 1, confirmed: false });
  });

  it('fails the task on a step that fails, and runs nothing after it', async () => {
    const worker = await startWorker([login, refuse, member]);
    const task = await createTask();
    const timeline = await run(worker, task);
    expect(timeline.task.status).toBe('failed');
    expect(trail(timeline)).toEqual([
      'transition:started',
      'step:browser_session',
      'step:login',
      'step:refuse',
      'transition:error',
    ]);
    expect(lastTransition(timeline)).toMatchObject({
      cause: 'error',
      detail: { reason: 'refuse: not today', detail: { because: 'testing' } },
    });
    expect(steps(timeline).at(-1)).toEqual({
      name: 'refuse',
      outcome: 'failed',
      detail: { reason: 'not today', detail: { because: 'testing' } },
    });
  });

  it('fails the task on a step that throws, naming the step', async () => {
    const worker = await startWorker([login, explode]);
    const task = await createTask();
    const timeline = await run(worker, task);
    expect(timeline.task.status).toBe('failed');
    expect(trail(timeline).at(-1)).toBe('transition:error');
    expect(lastTransition(timeline)).toMatchObject({
      cause: 'error',
      detail: { reason: 'explode: the page fell over' },
    });
    expect(steps(timeline).at(-1)).toEqual({
      name: 'explode',
      outcome: 'failed',
      detail: { reason: 'the page fell over' },
    });
  });

  it('guards every step: one that leaves the lane ends the task by violation, and nothing runs after it', async () => {
    const worker = await startWorker([login, wander, member]);
    const task = await createTask();
    const timeline = await run(worker, task);
    expect(timeline.task.status).toBe('failed');
    expect(trail(timeline)).toEqual([
      'transition:started',
      'step:browser_session',
      'step:login',
      'transition:violation',
    ]);
    expect(lastTransition(timeline)).toMatchObject({
      cause: 'violation',
      detail: { reason: `navigation to ${away()}/outside is outside the task's allowlist` },
    });
    expect((await toy.control.state()).hits).not.toContain('GET /outside');
  });

  it("hands the steps the task's input, the connection, and its profile when no other source is given", async () => {
    const worker = await startWorker([probe], { credentials: 'connection' });
    const task = await createTask({ input: { site: 'toy', plan: 'basic' } });
    const timeline = await run(worker, task);
    expect(timeline.task.status).toBe('succeeded');
    expect(timeline.task.result).toEqual({
      playbook: 'toy.custom',
      steps: [
        {
          name: 'probe',
          detail: {
            domain: toyHost(),
            credential: { kind: 'profile', profileId: 'toy-profile' },
            input: { site: 'toy', plan: 'basic' },
          },
        },
      ],
    });
  });
});

describe('refusals', () => {
  interface Refusal {
    readonly named: string;
    readonly task: () => Partial<TaskShape>;
    readonly reason: () => string;
  }

  const refusals: readonly Refusal[] = [
    {
      named: 'a site no playbook knows',
      task: () => ({ input: { site: 'nowhere' } }),
      reason: () => 'no playbook for custom on nowhere',
    },
    {
      named: 'an action the site has no playbook for',
      task: () => ({ kind: 'book_slot' }),
      reason: () => 'no playbook for book_slot on toy',
    },
    {
      named: 'an input that names no site',
      task: () => ({ input: { plan: 'basic' } }),
      reason: () => 'the task input names no site',
    },
    {
      named: 'an input that is not an object',
      task: () => ({ input: 'toy' }),
      reason: () => 'the task input is not an object',
    },
    {
      named: 'a person with no connection to the site',
      task: () => ({ userId: strangerId }),
      reason: () => `no site connection for ${toyHost()}`,
    },
    {
      named: 'a connection that has expired',
      task: () => ({ userId: expiredId }),
      reason: () => `the site connection for ${toyHost()} is expired`,
    },
    {
      named: 'a task in agentic mode',
      task: () => ({ mode: 'agentic' }),
      reason: () => 'agentic mode has no runner yet',
    },
  ];

  it.each(refusals)('refuses $named before any browser opens', async ({ task: overrides, reason }) => {
    const worker = await startWorker([login, member]);
    const task = await createTask(overrides());
    const timeline = await run(worker, task);
    expect(timeline.task.status).toBe('failed');
    expect(trail(timeline)).toEqual(['transition:started', 'transition:error']);
    expect(lastTransition(timeline)).toMatchObject({ cause: 'error', detail: { reason: reason() } });
    expect(timeline.task.solariSessionId).toBeNull();
  });

  it('refuses a connection that yields no credential, before any browser opens', async () => {
    const worker = await startWorker([login, member], { credentials: () => Promise.resolve(undefined) });
    const task = await createTask();
    const timeline = await run(worker, task);
    expect(timeline.task.status).toBe('failed');
    expect(trail(timeline)).toEqual(['transition:started', 'transition:error']);
    expect(lastTransition(timeline)).toMatchObject({
      cause: 'error',
      detail: { reason: `no credential for ${toyHost()}` },
    });
    expect(timeline.task.solariSessionId).toBeNull();
  });
});
