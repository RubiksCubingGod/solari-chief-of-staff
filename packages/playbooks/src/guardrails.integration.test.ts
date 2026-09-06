import { randomUUID } from 'node:crypto';

import {
  isTerminalTaskStatus,
  scriptedUserIO,
  type AskUserEventPayload,
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
  recordBrowserSession,
  registerTaskEngine,
  runMigrations,
  tasks,
  users,
  type Database,
  type JobHarness,
  type Mission,
  type Task,
  type TaskEvent,
  type TaskLedger,
  type TaskTimeline,
} from '@chief-of-staff/db';
import { startTestPostgres, type TestPostgres } from '@chief-of-staff/db/testing';
import { mountInstanceRoutes, startFixture, type FixtureHandle } from '@chief-of-staff/fixtures';
import { createLocalProvider, type BrowserProvider } from '@chief-of-staff/solari';
import type { Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { guardedSession, paymentConfirmations, stopOutcome, type GuardrailPolicy } from './guardrails/index.js';

/**
 * The guardrails on the real substrate: a task run by the engine on a pg-boss
 * worker over Testcontainers Postgres, a mission driving a local Chromium
 * through the guarded session, a person played from a script, and a site
 * with one lane and every way out of it. What the unit tests prove about the
 * rules, this proves about the browser: that the refusal happens below the
 * mission, before the request leaves, and lands on the task as the spec says.
 */

interface LaneState {
  readonly hits: readonly string[];
  readonly orders: number;
}

interface LaneControl {
  state(): Promise<LaneState>;
  reset(): Promise<LaneState>;
}

function html(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

/**
 * A site with one lane and every way out of it, plus a checkout. Test-local
 * rather than a fifth fixture: no playbook will ever run against it, and its
 * one job is to be somewhere the guard can refuse things. "Outside" is the
 * same server reached by another name, so the test needs no second port and
 * can still see whether a refused request arrived.
 */
function startLane(): Promise<FixtureHandle<LaneControl>> {
  let hits: string[] = [];
  let orders = 0;
  return startFixture(
    'lane',
    (app) => {
      app.use((request, _response, next) => {
        if (!request.path.startsWith('/__test')) hits.push(`${request.method} ${request.path}`);
        next();
      });
      mountInstanceRoutes<LaneState>(app, {
        state: () => ({ hits, orders }),
        seed: () => undefined,
        reset: () => {
          hits = [];
          orders = 0;
        },
      });
      const elsewhere = (port: number | undefined): string => `http://localhost:${String(port)}`;
      app.get('/', (request, response) => {
        const away = elsewhere(request.socket.localPort);
        response.type('html').send(
          html(
            'Lane',
            [
              '<h1>Lane</h1>',
              '<a href="/inside" data-testid="inside">Stay inside</a>',
              `<a href="${away}/outside" data-testid="outside">Go outside</a>`,
              '<a href="/leave" data-testid="leave">Leave through a redirect</a>',
              `<button type="button" data-testid="popup" onclick="window.open('${away}/popup')">Open a tab outside</button>`,
              '<form method="post" action="/search"><label>Search <input name="q" data-testid="q"></label>',
              '<button type="submit" data-testid="search">Search</button></form>',
            ].join(''),
          ),
        );
      });
      app.get('/inside', (_request, response) => {
        response.type('html').send(html('Inside', '<h1 data-testid="inside-heading">Still inside</h1>'));
      });
      app.get('/leave', (request, response) => {
        response.redirect(302, `${elsewhere(request.socket.localPort)}/landing`);
      });
      for (const path of ['/outside', '/popup', '/landing']) {
        app.get(path, (_request, response) => {
          response.type('html').send(html('Outside', '<h1>Outside the lane</h1>'));
        });
      }
      app.post('/search', (_request, response) => {
        response.type('html').send(html('Results', '<h1 data-testid="results">Results</h1>'));
      });
      app.get('/checkout', (_request, response) => {
        response.type('html').send(
          html(
            'Checkout',
            [
              '<h1>Checkout</h1><p>Order total: $49.00</p>',
              '<form method="post" action="/order">',
              '<label>Card number <input name="cardnumber" autocomplete="cc-number" data-testid="card"></label>',
              '<label>Expiry <input name="exp" autocomplete="cc-exp" data-testid="exp"></label>',
              '<label>CVC <input name="cvc" autocomplete="cc-csc" data-testid="cvc"></label>',
              '<button type="submit" data-testid="pay">Pay now</button></form>',
            ].join(''),
          ),
        );
      });
      app.post('/order', (_request, response) => {
        orders += 1;
        response.type('html').send(html('Thanks', '<h1 data-testid="thanks">Thank you for your order</h1>'));
      });
    },
    (request) => ({
      state: () => request<LaneState>('GET', '/__test/state'),
      reset: () => request<LaneState>('POST', '/__test/reset', {}),
    }),
  );
}

let postgres: TestPostgres;
let database: Database;
let userId: string;
let lane: FixtureHandle<LaneControl>;
let provider: BrowserProvider;
const harnesses: JobHarness[] = [];

/** What each test's task does, keyed by task id. */
const behaviours = new Map<string, Mission>();
const mission: Mission = (context) => {
  const behaviour = behaviours.get(context.task.id);
  if (behaviour === undefined) throw new Error(`no behaviour for task ${context.task.id}`);
  return behaviour(context);
};

/** The lane's own server, under the name the allowlist does not admit. */
const away = (): string => lane.url.replace('127.0.0.1', 'localhost');

const LANE_POLICY: GuardrailPolicy = { allowlist: ['127.0.0.1'] };

beforeAll(async () => {
  [postgres, lane] = await Promise.all([startTestPostgres(), startLane()]);
  await runMigrations(postgres.connectionString);
  database = createDatabase(postgres.connectionString);
  const [user] = await database.db
    .insert(users)
    .values({ email: `${randomUUID()}@example.test` })
    .returning();
  if (user === undefined) throw new Error('the user insert returned no row');
  userId = user.id;
  provider = createLocalProvider();
});

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.stop();
  expect(provider.liveSessionIds()).toEqual([]);
  await lane.control.reset();
});

afterAll(async () => {
  await provider.dispose();
  await lane.stop();
  await database.close();
  await postgres.stop();
});

interface Worker {
  readonly ledger: TaskLedger;
  readonly io: ScriptedUserIO;
}

/** A worker with the engine on it and a scripted person on its answer sink, on its own pg-boss schema. */
async function startWorker(script: readonly ScriptedReply[]): Promise<Worker> {
  const harness = createJobHarness({
    connectionString: postgres.connectionString,
    schema: `pgboss_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    pollingIntervalSeconds: 0.5,
  });
  const ledger: TaskLedger = { db: database.db, harness };
  const io = scriptedUserIO(createUserAnswerSink(ledger), script);
  await harness.start();
  await registerTaskEngine({ db: database.db, mission, userIO: io })(harness);
  harnesses.push(harness);
  return { ledger, io };
}

interface Run {
  readonly task: Task;
  readonly io: ScriptedUserIO;
}

async function runTask(script: readonly ScriptedReply[], behaviour: Mission): Promise<Run> {
  const { ledger, io } = await startWorker(script);
  const [task] = await database.db
    .insert(tasks)
    .values({ userId, kind: 'cancel', input: { site: 'lane' }, mode: 'playbook' })
    .returning();
  if (task === undefined) throw new Error('the task insert returned no row');
  behaviours.set(task.id, behaviour);
  await enqueueTaskRun(ledger, task.id);
  return { task, io };
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

/** A mission that drives `body` through a guarded local session, recording the session before anything else. */
function guarded(body: (page: Page) => Promise<unknown>): Mission {
  return async ({ task, answers }) => {
    const run = await guardedSession(
      { provider, policy: { ...LANE_POLICY, confirmedPayments: paymentConfirmations(answers) } },
      async (page, session) => {
        await recordBrowserSession(database.db, task.id, session);
        return body(page);
      },
    );
    return run.outcome.kind === 'stopped'
      ? stopOutcome(run.outcome.stop)
      : { kind: 'succeeded', result: run.outcome.value };
  };
}

function trail(timeline: TaskTimeline): string[] {
  return timeline.events.map((event) => {
    if (event.type === 'transition') return `transition:${(event.payload as TransitionEventPayload).cause}`;
    if (event.type === 'step') return `step:${(event.payload as StepEventPayload).name}`;
    return event.type;
  });
}

function payloads<T>(timeline: TaskTimeline, type: TaskEvent['type']): T[] {
  return timeline.events.filter((event) => event.type === type).map((event) => event.payload as T);
}

function lastTransition(timeline: TaskTimeline): TransitionEventPayload | undefined {
  return payloads<TransitionEventPayload>(timeline, 'transition').at(-1);
}

describe('the domain allowlist', () => {
  it('stops a clicked link off the lane before the site sees it, and fails the task with the URL', async () => {
    const { task } = await runTask(
      [],
      guarded(async (page) => {
        await page.goto(`${lane.url}/`);
        await page.getByTestId('outside').click();
        await page.getByTestId('inside-heading').waitFor();
        return 'reached the inside';
      }),
    );
    const timeline = await settled(task.id);
    expect(timeline.task.status).toBe('failed');
    expect(trail(timeline)).toEqual(['transition:started', 'step:browser_session', 'transition:violation']);
    expect(lastTransition(timeline)).toMatchObject({
      cause: 'violation',
      detail: {
        reason: `navigation to ${away()}/outside is outside the task's allowlist`,
        detail: {
          kind: 'allowlist',
          attemptedUrl: `${away()}/outside`,
          via: 'navigation',
          from: `${lane.url}/`,
          reason: 'host',
        },
      },
    });
    expect((await lane.control.state()).hits).not.toContain('GET /outside');
  });

  it('stops a server redirect that leaves the lane, naming both hops', async () => {
    const { task } = await runTask(
      [],
      guarded(async (page) => {
        await page.goto(`${lane.url}/leave`);
        return 'landed';
      }),
    );
    const timeline = await settled(task.id);
    expect(timeline.task.status).toBe('failed');
    expect(lastTransition(timeline)).toMatchObject({
      cause: 'violation',
      detail: {
        detail: {
          kind: 'allowlist',
          attemptedUrl: `${away()}/landing`,
          via: 'redirect',
          redirectedFrom: `${lane.url}/leave`,
        },
      },
    });
    const { hits } = await lane.control.state();
    expect(hits).toContain('GET /leave');
    expect(hits).not.toContain('GET /landing');
  });

  it('stops a new tab opened outside the lane, and nothing leaves the session after it', async () => {
    const { task } = await runTask(
      [],
      guarded(async (page) => {
        await page.goto(`${lane.url}/`);
        const refused = page
          .context()
          .waitForEvent('requestfailed', (request) => request.url().endsWith('/popup'));
        await page.getByTestId('popup').click();
        await refused;
        await page.goto(`${lane.url}/inside`);
        return 'kept going';
      }),
    );
    const timeline = await settled(task.id);
    expect(timeline.task.status).toBe('failed');
    expect(lastTransition(timeline)).toMatchObject({
      cause: 'violation',
      detail: { detail: { kind: 'allowlist', attemptedUrl: `${away()}/popup`, via: 'popup' } },
    });
    const { hits } = await lane.control.state();
    expect(hits).not.toContain('GET /popup');
    expect(hits).not.toContain('GET /inside');
  });
});

describe('the payment gate', () => {
  const checkout = async (page: Page): Promise<string> => {
    await page.goto(`${lane.url}/checkout`);
    await page.getByTestId('card').fill('4242 4242 4242 4242');
    await page.getByTestId('exp').fill('12/34');
    await page.getByTestId('cvc').fill('123');
    await page.getByTestId('pay').click();
    await page.getByTestId('thanks').waitFor();
    return 'paid';
  };

  it('asks before a payment-shaped submission, and a decline cancels the task with nothing sent', async () => {
    const { task, io } = await runTask([{ kind: 'decline' }], guarded(checkout));
    const timeline = await settled(task.id);
    expect(timeline.task.status).toBe('cancelled');
    expect(trail(timeline)).toEqual([
      'transition:started',
      'step:browser_session',
      'ask_user',
      'transition:asked',
      'transition:declined',
    ]);
    const [asked] = payloads<AskUserEventPayload>(timeline, 'ask_user');
    expect(asked?.question).toContain(`Page: Checkout (${lane.url}/checkout)`);
    expect(asked?.question).toContain(`Submission: POST ${lane.url}/order with cardnumber, exp, cvc`);
    expect(asked?.question).toContain('card value "cardnumber"');
    expect(asked?.question).toMatch(/\[payment-gate [0-9a-f]{16}\]$/);
    await io.settled();
    expect(io.outcomes).toEqual([{ accepted: true }]);
    const state = await lane.control.state();
    expect(state.orders).toBe(0);
    expect(state.hits).not.toContain('POST /order');
  });

  it('admits exactly the confirmed submission on the resumed run', async () => {
    const { task } = await runTask([{ kind: 'answer', reply: 'confirm' }], guarded(checkout));
    const timeline = await settled(task.id);
    expect(timeline.task.status).toBe('succeeded');
    expect(timeline.task.result).toBe('paid');
    expect(trail(timeline)).toEqual([
      'transition:started',
      'step:browser_session',
      'ask_user',
      'transition:asked',
      'user_reply',
      'transition:answered',
      'transition:resumed',
      'step:browser_session',
      'transition:succeeded',
    ]);
    const state = await lane.control.state();
    expect(state.orders).toBe(1);
    expect(state.hits.filter((hit) => hit === 'POST /order')).toHaveLength(1);
  });

  it('asks again when the reply is not a confirmation', async () => {
    const { task } = await runTask(
      [{ kind: 'answer', reply: 'what is this?' }, { kind: 'decline' }],
      guarded(checkout),
    );
    const timeline = await settled(task.id);
    expect(timeline.task.status).toBe('cancelled');
    expect(payloads<AskUserEventPayload>(timeline, 'ask_user')).toHaveLength(2);
    expect((await lane.control.state()).orders).toBe(0);
  });

  it('lets a submission that is not a payment through untouched', async () => {
    const { task } = await runTask(
      [],
      guarded(async (page) => {
        await page.goto(`${lane.url}/`);
        await page.getByTestId('q').fill('4242');
        await page.getByTestId('search').click();
        await page.getByTestId('results').waitFor();
        return 'searched';
      }),
    );
    const timeline = await settled(task.id);
    expect(timeline.task.status).toBe('succeeded');
    expect(trail(timeline)).toEqual(['transition:started', 'step:browser_session', 'transition:succeeded']);
    expect((await lane.control.state()).hits).toContain('POST /search');
  });
});

describe('the recording echo', () => {
  it('stores the session id and the honest answer about recording on the task and its trail', async () => {
    const { task } = await runTask(
      [],
      guarded(async (page) => {
        await page.goto(`${lane.url}/inside`);
        return 'done';
      }),
    );
    const timeline = await settled(task.id);
    expect(timeline.task.status).toBe('succeeded');
    expect(timeline.task.solariSessionId).toMatch(/^local-\d+$/);
    expect(timeline.task.recordingUrl).toBeNull();
    expect(payloads<StepEventPayload>(timeline, 'step')).toEqual([
      {
        name: 'browser_session',
        outcome: 'unrecorded',
        detail: {
          provider: 'local',
          sessionId: timeline.task.solariSessionId,
          recording: false,
          recordingUrl: null,
        },
      },
    ]);
  });
});
