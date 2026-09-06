import { randomUUID } from 'node:crypto';

import {
  LLM_UNAVAILABLE,
  TOOL_BUDGET_SPENT,
  createChatAgent,
  createHttpCrudClient,
  type ChatAgent,
  type CrudClient,
} from '@chief-of-staff/agent';
import { createApp, mintSessionCookie } from '@chief-of-staff/api';
import {
  ANSWER_RECORDED,
  BINDING_CONFIRMED,
  HOW_TO_BIND,
  RATE_LIMIT_NOTICE,
  createBotRuntime,
  loadBotConfig,
  type ChatLoop,
} from '@chief-of-staff/bot';
import {
  bindingCodes,
  calendarItems,
  createJobHarness,
  messages,
  runMigrations,
  taskEvents,
  tasks,
  users,
  watches,
  type JobHarness,
} from '@chief-of-staff/db';
import { startTestPostgres, type TestPostgres } from '@chief-of-staff/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createScriptedLlm,
  outage,
  say,
  useTool,
  type ScriptedLlm,
  type ScriptedTurn,
} from '../packages/agent/src/testing/scripted-llm.js';
import {
  TEST_BOT_INFO,
  createTestTransport,
  textUpdate,
  type TestTransport,
} from '../packages/bot/src/testing/transport.js';

/**
 * The whole front door in one process.
 *
 * A Telegram update arrives at the grammY runtime, crosses the transcript, the
 * rate limiter, the binding gate and the router, reaches the real chat agent
 * running the real Anthropic tool runner over the real HTTP tools, and comes
 * back out as rows in the API's database and words in the chat.
 *
 * Every package here has its own proofs; what this file adds is that they are
 * wired to each other. So the assertions are deliberately at the two ends — the
 * message Telegram would have received, and the row the dashboard would show —
 * rather than at any seam in between, because a chain of individually correct
 * links is exactly what a wiring defect looks like from the inside.
 *
 * Two things are stood in for, and only two: the Telegram network, replaced at
 * the API transformer, and the model's judgement, replaced at the SDK's
 * `fetch`. Both are the things this repository cannot make deterministic. The
 * real Claude call is proven separately and tagged, in
 * `packages/agent/src/live-llm.integration.test.ts`; the real Telegram
 * round-trip belongs to `calendar-wiring`, and the manual sanity check that
 * stands in for it meanwhile is written down in the sprint README.
 */

let postgres: TestPostgres;
let harness: JobHarness;
// Taken from the factory rather than imported: Fastify belongs to the API
// package, and everything here is a client of the server it starts.
/**
 * Configured on the server below, so this suite can mint the session a caller
 * presents. `mintSessionCookie` is a test credential by contract, and it is
 * legitimate here precisely because this suite owns the secret it signs with.
 */
const SESSION_SECRET = 'the-secret-this-suite-configured';

let app: ReturnType<typeof createApp>;
let crud: CrudClient;

const BOUND_CHAT = '77001';
const STRANGER_CHAT = '77002';
/** Ten characters from the issuing alphabet, so it is a code and not a typo. */
const A_CODE = 'CHATD00R99';

const A_WATCH = {
  kind: 'price',
  url: 'https://shop.test/kettle',
  schedule: '0 * * * *',
  condition: { drops_below: 2000 },
} as const;

beforeAll(async () => {
  postgres = await startTestPostgres();
  await runMigrations(postgres.connectionString);
  harness = createJobHarness({
    connectionString: postgres.connectionString,
    schema: 'pgboss_frontdoor',
  });
  await harness.start();
  app = createApp({
    DATABASE_URL: postgres.connectionString,
    LOG_LEVEL: 'silent',
    SESSION_SECRET,
  });
  // On a real socket rather than through `inject`: the chat tools are an HTTP
  // client, and a composition that skipped the transport would not be the one
  // that ships.
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  crud = createHttpCrudClient({
    baseUrl,
    credential: (caller) => ({ cookie: mintSessionCookie(caller, SESSION_SECRET) }),
  });
});

afterAll(async () => {
  try {
    await harness.stop();
    await app.close();
  } finally {
    await postgres.stop();
  }
});

beforeEach(async () => {
  await app.db.delete(messages);
  await app.db.delete(watches);
  await app.db.delete(calendarItems);
  await app.db.delete(taskEvents);
  await app.db.delete(tasks);
  await app.db.delete(bindingCodes);
  await app.db.delete(users);
});

/**
 * The one adapter the composition needs: the bot's `ChatLoop` port, over the
 * agent package's `ChatAgent`.
 *
 * It is this short because the two were built to meet — the bot works out who
 * is speaking, the agent acts as them and nobody else — and the process entry
 * point that wires them together for real will write the same few lines rather
 * than anything larger. Its brevity is the claim this file is making.
 */
function chatLoopOver(agent: ChatAgent): ChatLoop {
  return {
    async respond({ userId, text }) {
      const turn = await agent.respond({ userId, text });
      return turn.reply;
    },
  };
}

interface FrontDoor {
  readonly llm: ScriptedLlm;
  readonly transport: TestTransport;
  /** One Telegram message, handled the way a delivered update is handled. */
  send(chatId: string, text: string): Promise<void>;
}

interface FrontDoorOptions {
  /** What the model answers with, turn by turn. */
  readonly script: readonly ScriptedTurn[];
  /** How many CRUD calls one message may make; kept small in the budget proof. */
  readonly toolBudget?: number;
  /** How many messages a chat may send at once; kept small in the flood proof. */
  readonly burst?: number;
}

function openFrontDoor(options: FrontDoorOptions): FrontDoor {
  const llm = createScriptedLlm(...options.script);
  const agent = createChatAgent({
    client: llm.client,
    crud,
    ...(options.toolBudget === undefined ? {} : { toolBudget: options.toolBudget }),
  });
  const transport = createTestTransport();
  const runtime = createBotRuntime({
    config: loadBotConfig({
      TELEGRAM_BOT_TOKEN: '123456:test-token',
      DATABASE_URL: postgres.connectionString,
      TELEGRAM_RATE_LIMIT_BURST: String(options.burst ?? 20),
      TELEGRAM_RATE_LIMIT_PER_MINUTE: '60',
      TELEGRAM_RATE_LIMIT_NOTICE_SECONDS: '60',
    }),
    db: app.db,
    harness,
    transformer: transport.transformer,
    botInfo: TEST_BOT_INFO,
    chatLoop: chatLoopOver(agent),
  });
  // Never started: `handleUpdate` is what a delivered update reaches in either
  // transport, so driving it directly proves the same pipeline without a poll
  // loop or a webhook server in the way.
  return { llm, transport, send: (chatId, text) => runtime.bot.handleUpdate(textUpdate(chatId, text)) };
}

async function createUser(): Promise<string> {
  const [created] = await app.db.insert(users).values({}).returning();
  if (created === undefined) throw new Error('the fixture user was not created');
  return created.id;
}

/** A user whose chat is already bound, for the proofs that are about what comes after. */
async function bindUser(chatId: string): Promise<string> {
  const [created] = await app.db.insert(users).values({ telegramChatId: chatId }).returning();
  if (created === undefined) throw new Error('the fixture user was not created');
  return created.id;
}

/**
 * A code sitting in the table, as `POST /binding-codes` would have left it.
 * Issuing it over HTTP is `account-binding`'s proof and is not repeated here:
 * this file is about what a chat can do, and re-proving the dashboard's half
 * would tie it to an authentication seam it does not otherwise touch.
 */
async function issueCode(userId: string): Promise<string> {
  await app.db.insert(bindingCodes).values({
    userId,
    code: A_CODE,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  return A_CODE;
}

async function seedWatch(userId: string, url: string): Promise<string> {
  const [created] = await app.db
    .insert(watches)
    .values({ ...A_WATCH, url, userId, extractor: {} })
    .returning();
  if (created === undefined) throw new Error('the fixture watch was not created');
  return created.id;
}

/** A job parked on a question, which is what makes the next message an answer. */
async function askQuestion(userId: string, question: string): Promise<string> {
  const [task] = await app.db
    .insert(tasks)
    .values({
      userId,
      kind: 'cancel',
      input: { what: 'gym' },
      status: 'waiting_user',
      mode: 'playbook',
    })
    .returning();
  if (task === undefined) throw new Error('the fixture task was not created');
  const askedAt = Date.now();
  await app.db.insert(taskEvents).values({
    taskId: task.id,
    type: 'ask_user',
    payload: {
      questionId: randomUUID(),
      question,
      askedAt: new Date(askedAt).toISOString(),
      expiresAt: new Date(askedAt + 3_600_000).toISOString(),
    },
  });
  return task.id;
}

/** What the API says this user has, read back through the same client the tools use. */
async function apiList(userId: string, path: string): Promise<unknown[]> {
  const response = await crud.request(userId, 'GET', path);
  if (!response.ok) {
    throw new Error(`${path} answered ${String(response.status)}: ${response.reason}`);
  }
  return response.body as unknown[];
}

/**
 * The whole transcript, oldest first. Unfiltered because every proof here talks
 * to one chat at a time and the table is emptied between them, so a row this
 * did not expect is a finding rather than noise from a neighbour.
 */
async function transcript(): Promise<
  { chatId: string | null; direction: string; text: string; userId: string | null }[]
> {
  const rows = await app.db.select().from(messages).orderBy(messages.ts, messages.id);
  return rows.map((row) => ({
    chatId: row.chatId,
    direction: row.direction,
    text: row.text,
    userId: row.userId,
  }));
}

describe('a chat that has just met the bot', () => {
  it('binds with its code, then has its first request carried out', async () => {
    const userId = await createUser();
    const code = await issueCode(userId);
    const confirmation = 'Watching that kettle - I will tell you if it drops under £20.';
    const door = openFrontDoor({ script: [useTool('create_watch', A_WATCH), say(confirmation)] });

    await door.send(BOUND_CHAT, `/start ${code}`);
    await door.send(BOUND_CHAT, 'watch the kettle and tell me if it goes under 20 quid');

    expect(door.transport.sent()).toEqual([
      { chatId: BOUND_CHAT, text: BINDING_CONFIRMED },
      { chatId: BOUND_CHAT, text: confirmation },
    ]);
    // The words came from the model and the row came from the API, and the row
    // belongs to the person whose chat it was. All three had to line up.
    expect(await apiList(userId, '/watches')).toMatchObject([
      { userId, kind: 'price', url: A_WATCH.url, status: 'active' },
    ]);
    // Two requests, both from the second message: the `/start` was redeemed and
    // stopped there rather than being handed to the loop as an instruction.
    expect(door.llm.requests()).toHaveLength(2);
  });

  it('tells a stranger the way in, and never wakes the model to do it', async () => {
    const door = openFrontDoor({ script: [say('the model should not be reached at all')] });

    await door.send(STRANGER_CHAT, 'watch this page for me');

    expect(door.transport.sent()).toEqual([{ chatId: STRANGER_CHAT, text: HOW_TO_BIND }]);
    // The binding gate is an authorization boundary, so the cost of crossing it
    // matters as much as the refusal: an unbound stranger must not be able to
    // spend the Anthropic budget by typing.
    expect(door.llm.requests()).toEqual([]);
    expect(await app.db.select().from(watches)).toEqual([]);
  });
});

describe('an order that reaches the API', () => {
  it('shows this user their own watches and nobody else’s', async () => {
    const userId = await bindUser(BOUND_CHAT);
    const strangerId = await createUser();
    await seedWatch(userId, 'https://shop.test/kettle');
    await seedWatch(strangerId, 'https://shop.test/not-yours');

    const door = openFrontDoor({ script: [useTool('list_watches', {}), say('Just the kettle.')] });

    await door.send(BOUND_CHAT, 'what am I watching?');

    expect(door.transport.sent()).toEqual([{ chatId: BOUND_CHAT, text: 'Just the kettle.' }]);
    // Read at the model rather than at the reply: the identity has to survive
    // chat id → bound user → caller on the CRUD request, and this is the only
    // place that whole chain is visible at once.
    const [result] = door.llm.toolResults();
    expect(result?.content).toContain('https://shop.test/kettle');
    expect(result?.content).not.toContain('not-yours');
  });

  it('pauses a watch, and the API shows it paused', async () => {
    const userId = await bindUser(BOUND_CHAT);
    const watchId = await seedWatch(userId, 'https://shop.test/kettle');
    const door = openFrontDoor({
      script: [useTool('pause_watch', { watchId, status: 'paused' }), say('Paused.')],
    });

    await door.send(BOUND_CHAT, 'pause the kettle one');

    expect(door.transport.sent()).toEqual([{ chatId: BOUND_CHAT, text: 'Paused.' }]);
    expect(await apiList(userId, '/watches')).toMatchObject([{ id: watchId, status: 'paused' }]);
  });

  it('queues a cancellation, and says only that it is queued', async () => {
    const userId = await bindUser(BOUND_CHAT);
    const door = openFrontDoor({
      script: [
        useTool('create_task', { kind: 'cancel', input: { what: 'gym' } }),
        say('I have queued the cancellation.'),
      ],
    });

    await door.send(BOUND_CHAT, 'cancel my gym');

    expect(door.transport.sent()).toEqual([
      { chatId: BOUND_CHAT, text: 'I have queued the cancellation.' },
    ]);
    expect(await apiList(userId, '/tasks')).toMatchObject([
      { userId, kind: 'cancel', input: { what: 'gym' }, status: 'queued', mode: 'playbook' },
    ]);
    // The word "queued" is in the reply because the tool result put it in front
    // of the model. Asserting the scripted sentence alone would prove nothing
    // about what a real model would have to say.
    expect(door.llm.toolResults()[0]?.content).toContain('queued');
  });
});

describe('a request the front door refuses', () => {
  it('stops at the tool budget, and says so in the chat', async () => {
    const userId = await bindUser(BOUND_CHAT);
    const door = openFrontDoor({
      toolBudget: 2,
      script: [
        useTool('list_watches', {}),
        useTool('list_watches', {}),
        useTool('list_watches', {}),
        useTool('list_watches', {}),
      ],
    });

    await door.send(BOUND_CHAT, 'keep looking');

    // The loop's own refusal, delivered as a message rather than as silence.
    expect(door.transport.sent()).toEqual([{ chatId: BOUND_CHAT, text: TOOL_BUDGET_SPENT }]);
    expect(await apiList(userId, '/watches')).toEqual([]);
  });

  it('passes the API’s own reason to the model, and writes nothing', async () => {
    const userId = await bindUser(BOUND_CHAT);
    const apology = 'That URL needs the https:// on the front, and I need a real schedule.';
    const door = openFrontDoor({
      script: [
        useTool('create_watch', {
          kind: 'price',
          url: 'shop.test/kettle',
          schedule: 'every other friday',
          condition: { drops_below: 2000 },
        }),
        say(apology),
      ],
    });

    await door.send(BOUND_CHAT, 'watch shop.test/kettle weekly');

    const [result] = door.llm.toolResults();
    expect(result?.isError).toBe(true);
    // The fields the API named, named to the model. A generic "that failed" is
    // what this assertion exists to catch.
    expect(result?.content).toContain('/url');
    expect(result?.content).toContain('/schedule');
    expect(door.transport.sent()).toEqual([{ chatId: BOUND_CHAT, text: apology }]);
    expect(await apiList(userId, '/watches')).toEqual([]);
  });

  it('apologises when the model is unreachable, and changes nothing', async () => {
    const userId = await bindUser(BOUND_CHAT);
    const door = openFrontDoor({ script: [outage()] });

    await door.send(BOUND_CHAT, 'watch the kettle for me');

    expect(door.transport.sent()).toEqual([{ chatId: BOUND_CHAT, text: LLM_UNAVAILABLE }]);
    expect(await apiList(userId, '/watches')).toEqual([]);
  });

  it('refuses a flood with one notice, and the refused messages never reach the model', async () => {
    await bindUser(BOUND_CHAT);
    const answered = 'only the first one gets this far';
    const door = openFrontDoor({ burst: 1, script: [say(answered)] });

    await door.send(BOUND_CHAT, 'first');
    await door.send(BOUND_CHAT, 'second');
    await door.send(BOUND_CHAT, 'third');

    expect(door.transport.sent()).toEqual([
      { chatId: BOUND_CHAT, text: answered },
      { chatId: BOUND_CHAT, text: RATE_LIMIT_NOTICE },
    ]);
    // The limiter sits in front of the model, which is most of the point of
    // having it: a flood costs one turn, not one per message.
    expect(door.llm.requests()).toHaveLength(1);
  });
});

describe('a message that answers a question a job asked', () => {
  it('goes to the job rather than to the model', async () => {
    const userId = await bindUser(BOUND_CHAT);
    const taskId = await askQuestion(userId, 'Which gym - Southside or Riverside?');
    const door = openFrontDoor({ script: [say('the model should not be asked this')] });

    await door.send(BOUND_CHAT, 'Southside');

    expect(door.transport.sent()).toEqual([{ chatId: BOUND_CHAT, text: ANSWER_RECORDED }]);
    // Both halves: the answer landed on the job's own timeline, and the loop
    // never saw it. Handing "Southside" to a model as an instruction is the
    // failure this routing exists to prevent.
    const written = await app.db.select().from(taskEvents);
    expect(written.filter((event) => event.type === 'user_reply')).toMatchObject([
      { taskId, payload: { reply: 'Southside' } },
    ]);
    expect(door.llm.requests()).toEqual([]);
  });
});

describe('the transcript', () => {
  it('has both halves of every exchange, refusals included', async () => {
    const userId = await createUser();
    const code = await issueCode(userId);
    const confirmation = 'Watching it.';
    const door = openFrontDoor({ script: [useTool('create_watch', A_WATCH), say(confirmation)] });

    await door.send(BOUND_CHAT, 'hello?');
    await door.send(BOUND_CHAT, `/start ${code}`);
    await door.send(BOUND_CHAT, 'watch the kettle for me');

    // Six rows for three messages, in order, with nothing dropped for having
    // been refused. The attribution moves partway through and does not go back:
    // the two messages before the chat had an owner are recorded without one,
    // which is what makes the failed-to-bind exchanges readable afterwards.
    expect(await transcript()).toEqual([
      { chatId: BOUND_CHAT, direction: 'inbound', text: 'hello?', userId: null },
      { chatId: BOUND_CHAT, direction: 'outbound', text: HOW_TO_BIND, userId: null },
      { chatId: BOUND_CHAT, direction: 'inbound', text: `/start ${code}`, userId: null },
      { chatId: BOUND_CHAT, direction: 'outbound', text: BINDING_CONFIRMED, userId },
      { chatId: BOUND_CHAT, direction: 'inbound', text: 'watch the kettle for me', userId },
      { chatId: BOUND_CHAT, direction: 'outbound', text: confirmation, userId },
    ]);
  });
});
