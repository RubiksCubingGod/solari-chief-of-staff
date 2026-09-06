import { randomUUID } from 'node:crypto';

import type { UserResolutionOutcome } from '@chief-of-staff/core';
import {
  createDatabase,
  createJobHarness,
  messages,
  runMigrations,
  taskEvents,
  tasks,
  users,
  type Database,
  type JobHarness,
} from '@chief-of-staff/db';
import { startTestPostgres, type TestPostgres } from '@chief-of-staff/db/testing';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadBotConfig, type BotConfig } from './config.js';
import {
  ANSWER_RECORDED,
  ASSISTANT_UNAVAILABLE,
  DECLINE_RECORDED,
  HOW_TO_BIND,
  QUESTION_CLOSED,
} from './replies.js';
import {
  routeMessage,
  type AnswerSink,
  type ChatLoop,
  type ChatLoopRequest,
  type QuestionAnswer,
} from './routing.js';
import { createBotRuntime, type BotRuntime } from './runtime.js';
import {
  TEST_BOT_INFO,
  createTestTransport,
  textUpdate,
  type TestTransport,
} from './testing/transport.js';

/**
 * The router, on the composed path a real message takes: through the runtime,
 * the transcript, the rate limiter and the binding gate, into exactly one of
 * two destinations.
 *
 * Every test here asserts both halves - what the message reached and what it
 * did not - because the failure this router exists to prevent is not a message
 * going to the wrong place. It is a message going to both places, which books
 * an appointment out of an answer, or to neither, which loses it silently.
 *
 * The answer's destination is the real task ledger over a real job harness:
 * a reply the bot accepts is a task queued to run with it, a no is a task
 * cancelled, and a reply that came too late is refused and said so.
 */

const CHAT = '80001';
const OTHER_CHAT = '80002';
const HOUR_MS = 3_600_000;

let postgres: TestPostgres;
let database: Database;
let harness: JobHarness;
const started: BotRuntime[] = [];

/** A chat loop that records what it was asked and answers with a fixed line. */
function spyLoop(reply = 'here is what I did'): ChatLoop & { readonly seen: ChatLoopRequest[] } {
  const seen: ChatLoopRequest[] = [];
  return {
    seen,
    respond(request: ChatLoopRequest): Promise<string> {
      seen.push(request);
      return Promise.resolve(reply);
    },
  };
}

/** A sink that records what it was handed and answers as told, instead of the ledger. */
function spySink(
  outcome: UserResolutionOutcome = { accepted: true },
): AnswerSink & { readonly seen: QuestionAnswer[] } {
  const seen: QuestionAnswer[] = [];
  return {
    seen,
    deliver(answer: QuestionAnswer): Promise<UserResolutionOutcome> {
      seen.push(answer);
      return Promise.resolve(outcome);
    },
  };
}

async function createUser(chatId: string | null = null): Promise<string> {
  const [created] = await database.db
    .insert(users)
    .values(chatId === null ? {} : { telegramChatId: chatId })
    .returning();
  if (created === undefined) throw new Error('the fixture user was not created');
  return created.id;
}

interface Asked {
  readonly taskId: string;
  readonly questionId: string;
}

/**
 * A task parked on a question, the way the engine parks one: the status, and
 * the `ask_user` event with the id and the deadline the ledger reads back.
 */
async function askQuestion(userId: string, question: string, expiresInMs = HOUR_MS): Promise<Asked> {
  const [task] = await database.db
    .insert(tasks)
    .values({
      userId,
      kind: 'cancel',
      input: { site: 'fakegym' },
      mode: 'playbook',
      status: 'waiting_user',
    })
    .returning();
  if (task === undefined) throw new Error('the fixture task was not created');
  const questionId = randomUUID();
  const askedAt = Date.now();
  await database.db.insert(taskEvents).values({
    taskId: task.id,
    type: 'ask_user',
    payload: {
      questionId,
      question,
      askedAt: new Date(askedAt).toISOString(),
      expiresAt: new Date(askedAt + expiresInMs).toISOString(),
    },
  });
  return { taskId: task.id, questionId };
}

async function eventsOf(taskId: string): Promise<{ type: string; payload: unknown }[]> {
  const rows = await database.db
    .select({ type: taskEvents.type, payload: taskEvents.payload })
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    .orderBy(asc(taskEvents.seq));
  return rows;
}

async function taskOf(taskId: string): Promise<{ status: string; jobId: string | null }> {
  const [row] = await database.db
    .select({ status: tasks.status, jobId: tasks.jobId })
    .from(tasks)
    .where(eq(tasks.id, taskId));
  if (row === undefined) throw new Error(`task ${taskId} vanished`);
  return row;
}

async function transcript(): Promise<{ direction: string; text: string }[]> {
  const rows = await database.db
    .select({ direction: messages.direction, text: messages.text, ts: messages.ts })
    .from(messages)
    .orderBy(asc(messages.ts));
  return rows.map((row) => ({ direction: row.direction, text: row.text }));
}

function configFor(): BotConfig {
  return loadBotConfig({
    TELEGRAM_BOT_TOKEN: '123456:test-token',
    DATABASE_URL: postgres.connectionString,
    // High enough that nothing here is refused as a flood.
    TELEGRAM_RATE_LIMIT_BURST: '20',
    TELEGRAM_RATE_LIMIT_PER_MINUTE: '60',
    TELEGRAM_RATE_LIMIT_NOTICE_SECONDS: '60',
  });
}

function runtimeFor(transport: TestTransport, chatLoop: ChatLoop, answerSink?: AnswerSink): BotRuntime {
  const runtime = createBotRuntime({
    config: configFor(),
    db: database.db,
    harness,
    transformer: transport.transformer,
    botInfo: TEST_BOT_INFO,
    chatLoop,
    ...(answerSink === undefined ? {} : { answerSink }),
  });
  started.push(runtime);
  return runtime;
}

beforeAll(async () => {
  postgres = await startTestPostgres();
  await runMigrations(postgres.connectionString);
  database = createDatabase(postgres.connectionString);
  harness = createJobHarness({ connectionString: postgres.connectionString, schema: 'pgboss_routing' });
  await harness.start();
});

afterAll(async () => {
  try {
    await Promise.all(started.splice(0).map((runtime) => runtime.stop()));
    await harness.stop();
    await database.close();
  } finally {
    await postgres.stop();
  }
});

beforeEach(async () => {
  await database.db.delete(messages);
  await database.db.delete(taskEvents);
  await database.db.delete(tasks);
  await database.db.delete(users);
});

describe('a message that answers a pending question', () => {
  it('reaches the answer sink and never the chat loop', async () => {
    const userId = await createUser(CHAT);
    const { taskId, questionId } = await askQuestion(userId, 'Which membership should I cancel?');
    const transport = createTestTransport();
    const loop = spyLoop();
    const sink = spySink();
    const runtime = runtimeFor(transport, loop, sink);

    await runtime.bot.handleUpdate(textUpdate(CHAT, 'the annual one, please'));

    expect(sink.seen).toEqual([
      {
        userId,
        taskId,
        questionId,
        question: 'Which membership should I cancel?',
        text: 'the annual one, please',
        resolution: { kind: 'answer', reply: 'the annual one, please' },
      },
    ]);
    // The other destination, asserted empty. Either assertion alone would pass
    // for a message that went to both.
    expect(loop.seen).toEqual([]);
    expect(transport.sent()).toEqual([{ chatId: CHAT, text: ANSWER_RECORDED }]);
  });

  it('hands the answer to the task ledger, which queues the task to run with it', async () => {
    const userId = await createUser(CHAT);
    const { taskId, questionId } = await askQuestion(userId, 'Which membership should I cancel?');
    const transport = createTestTransport();
    const runtime = runtimeFor(transport, spyLoop());

    await runtime.bot.handleUpdate(textUpdate(CHAT, 'the annual one, please'));

    // The default sink is the ledger, not a stub: the reply is on the task's
    // timeline under the question's id, the task is queued, and there is a
    // job on the harness to run it. What is absent here is only the engine.
    expect(await taskOf(taskId)).toMatchObject({ status: 'queued' });
    expect((await taskOf(taskId)).jobId).not.toBeNull();
    expect(await eventsOf(taskId)).toMatchObject([
      { type: 'ask_user', payload: { questionId, question: 'Which membership should I cancel?' } },
      { type: 'user_reply', payload: { questionId, reply: 'the annual one, please' } },
      { type: 'transition', payload: { from: 'waiting_user', to: 'queued', cause: 'answered' } },
    ]);
  });

  it('transcribes both halves of the exchange', async () => {
    const userId = await createUser(CHAT);
    await askQuestion(userId, 'Which membership should I cancel?');
    const transport = createTestTransport();
    const runtime = runtimeFor(transport, spyLoop());

    await runtime.bot.handleUpdate(textUpdate(CHAT, 'the annual one, please'));

    expect(await transcript()).toEqual([
      { direction: 'inbound', text: 'the annual one, please' },
      { direction: 'outbound', text: ANSWER_RECORDED },
    ]);
  });

  it('is an answer exactly once, so the next message is a new request', async () => {
    const userId = await createUser(CHAT);
    await askQuestion(userId, 'Which membership should I cancel?');
    const transport = createTestTransport();
    const loop = spyLoop();
    const runtime = runtimeFor(transport, loop);

    await runtime.bot.handleUpdate(textUpdate(CHAT, 'the annual one, please'));
    await runtime.bot.handleUpdate(textUpdate(CHAT, 'also watch the kettle page'));

    // The question has been answered, so nothing is pending and the second
    // message is an ordinary request. A router that kept answering the same
    // question would swallow every message after the first one forever.
    expect(loop.seen.map((request) => request.text)).toEqual(['also watch the kettle page']);
  });

  it('ends the task on a plain no, and says so', async () => {
    const userId = await createUser(CHAT);
    const { taskId } = await askQuestion(userId, 'Cancel Gym before it renews on 2026-09-12?');
    const transport = createTestTransport();
    const loop = spyLoop();
    const runtime = runtimeFor(transport, loop);

    await runtime.bot.handleUpdate(textUpdate(CHAT, 'No thanks.'));

    // A no is not an answer for the task to read; it is the end of the task,
    // without any of it running. The person is told that, in those words.
    expect(transport.sent()).toEqual([{ chatId: CHAT, text: DECLINE_RECORDED }]);
    expect(await taskOf(taskId)).toMatchObject({ status: 'cancelled' });
    expect(await eventsOf(taskId)).toMatchObject([
      { type: 'ask_user' },
      { type: 'transition', payload: { to: 'cancelled', cause: 'declined' } },
    ]);
    expect(loop.seen).toEqual([]);
  });

  it('tells the person when the question has closed, and moves on', async () => {
    const userId = await createUser(CHAT);
    const { taskId } = await askQuestion(userId, 'Which membership should I cancel?', -HOUR_MS);
    const transport = createTestTransport();
    const loop = spyLoop();
    const runtime = runtimeFor(transport, loop);

    await runtime.bot.handleUpdate(textUpdate(CHAT, 'the annual one, please'));
    await runtime.bot.handleUpdate(textUpdate(CHAT, 'watch the kettle page for me'));

    // The ledger refused the reply because the question's deadline had
    // passed, and it failed the task on the spot. Saying "passed along" here
    // would leave the person believing a cancellation is under way.
    expect(transport.sent().map((sent) => sent.text)).toEqual([
      QUESTION_CLOSED,
      'here is what I did',
    ]);
    expect(await taskOf(taskId)).toMatchObject({ status: 'failed' });
    expect(loop.seen.map((request) => request.text)).toEqual(['watch the kettle page for me']);
  });

  it('tells the person when the sink would not take the reply', async () => {
    const userId = await createUser(CHAT);
    await askQuestion(userId, 'Which membership should I cancel?');
    const transport = createTestTransport();
    const sink = spySink({ accepted: false, reason: 'not_waiting' });
    const runtime = runtimeFor(transport, spyLoop(), sink);

    await runtime.bot.handleUpdate(textUpdate(CHAT, 'the annual one, please'));

    expect(sink.seen).toHaveLength(1);
    expect(transport.sent()).toEqual([{ chatId: CHAT, text: QUESTION_CLOSED }]);
  });
});

describe('a message that is not an answer', () => {
  it('reaches the chat loop and comes back with its reply', async () => {
    const userId = await createUser(CHAT);
    const transport = createTestTransport();
    const loop = spyLoop('your watch is live');
    const sink = spySink();
    const runtime = runtimeFor(transport, loop, sink);

    await runtime.bot.handleUpdate(textUpdate(CHAT, 'watch the kettle page for me'));

    expect(loop.seen).toEqual([{ userId, chatId: CHAT, text: 'watch the kettle page for me' }]);
    expect(sink.seen).toEqual([]);
    expect(transport.sent()).toEqual([{ chatId: CHAT, text: 'your watch is live' }]);
    expect(await transcript()).toEqual([
      { direction: 'inbound', text: 'watch the kettle page for me' },
      { direction: 'outbound', text: 'your watch is live' },
    ]);
  });

  it('is not an answer to a question somebody else was asked', async () => {
    const userId = await createUser(CHAT);
    const otherId = await createUser(OTHER_CHAT);
    await askQuestion(otherId, 'Which membership should I cancel?');
    const transport = createTestTransport();
    const loop = spyLoop();
    const sink = spySink();
    const runtime = runtimeFor(transport, loop, sink);

    await runtime.bot.handleUpdate(textUpdate(CHAT, 'the annual one, please'));

    // The pending question is real, and it is not this user's. Routing by the
    // question rather than by the person would hand one user's words to
    // another user's job.
    expect(sink.seen).toEqual([]);
    expect(loop.seen).toEqual([{ userId, chatId: CHAT, text: 'the annual one, please' }]);
  });

  it('is not an answer when the waiting task has asked nothing', async () => {
    const userId = await createUser(CHAT);
    await database.db.insert(tasks).values({
      userId,
      kind: 'cancel',
      input: { site: 'fakegym' },
      mode: 'playbook',
      status: 'waiting_user',
    });
    const transport = createTestTransport();
    const loop = spyLoop();
    const sink = spySink();
    const runtime = runtimeFor(transport, loop, sink);

    await runtime.bot.handleUpdate(textUpdate(CHAT, 'go on then'));

    // `waiting_user` with no question recorded is a task mid-transition, not a
    // question. Treating the status alone as an invitation would route a
    // request into a job that never asked anything.
    expect(sink.seen).toEqual([]);
    expect(loop.seen).toHaveLength(1);
  });
});

describe('what counts as a pending question', () => {
  it('ignores an ask_user event that carries no question anyone could answer', async () => {
    const userId = await createUser(CHAT);
    await parkOn(userId, { questionId: randomUUID(), prompt: 'Which membership should I cancel?' });
    const transport = createTestTransport();
    const loop = spyLoop();
    const sink = spySink();
    const runtime = runtimeFor(transport, loop, sink);

    await runtime.bot.handleUpdate(textUpdate(CHAT, 'the annual one, please'));

    // Nothing readable was asked, so nothing can be an answer to it. Parking
    // the chat on an unreadable question would take every message the user
    // sends from then on and file it against a question they never saw.
    expect(sink.seen).toEqual([]);
    expect(loop.seen).toHaveLength(1);
  });

  it('ignores an ask_user event with no id the ledger could file a reply under', async () => {
    const userId = await createUser(CHAT);
    await parkOn(userId, { question: 'Which membership should I cancel?' });
    const transport = createTestTransport();
    const loop = spyLoop();
    const sink = spySink();
    const runtime = runtimeFor(transport, loop, sink);

    await runtime.bot.handleUpdate(textUpdate(CHAT, 'the annual one, please'));

    expect(sink.seen).toEqual([]);
    expect(loop.seen).toHaveLength(1);
  });

  it('answers the most recent question when two jobs are waiting at once', async () => {
    const userId = await createUser(CHAT);
    await askQuestion(userId, 'Which membership should I cancel?');
    const newer = await askQuestion(userId, 'Which of the two cards should I use?');
    const transport = createTestTransport();
    const sink = spySink();
    const runtime = runtimeFor(transport, spyLoop(), sink);

    await runtime.bot.handleUpdate(textUpdate(CHAT, 'the second one'));

    // Nothing in the words says which job is being answered. The newest
    // question is the one still on the user's screen, so it is the one their
    // next message is about.
    expect(sink.seen.map((answer) => answer.taskId)).toEqual([newer.taskId]);
  });

  it('sends a chat whose binding vanished mid-message back to how-to-bind', async () => {
    // The binding gate has already found a user by the time the router runs,
    // so this is the window between those two reads: a chat rebound, or a user
    // deleted, in the middle of one message. Driven directly because the
    // composed path cannot open a window that narrow on purpose.
    const loop = spyLoop();
    const sink = spySink();

    const said = await routeMessage(
      database.db,
      { chatLoop: loop, answerSink: sink },
      { chatId: CHAT, text: 'the annual one, please' },
    );

    expect(said).toBe(HOW_TO_BIND);
    expect(loop.seen).toEqual([]);
    expect(sink.seen).toEqual([]);
  });
});

describe('a destination that fails', () => {
  it('still answers the user when the chat loop returns nothing to say', async () => {
    await createUser(CHAT);
    const transport = createTestTransport();
    const runtime = runtimeFor(transport, { respond: () => Promise.resolve('') });

    await runtime.bot.handleUpdate(textUpdate(CHAT, 'watch the kettle page for me'));

    // An empty reply is not an answer, and Telegram would refuse to send it
    // anyway; silence here would read to the user as the message never having
    // arrived.
    expect(transport.sent()).toEqual([{ chatId: CHAT, text: ASSISTANT_UNAVAILABLE }]);
  });

  it('still answers the user when the chat loop throws', async () => {
    await createUser(CHAT);
    const transport = createTestTransport();
    const runtime = runtimeFor(transport, {
      respond: () => Promise.reject(new Error('the loop fell over')),
    });

    await runtime.bot.handleUpdate(textUpdate(CHAT, 'watch the kettle page for me'));

    // Never swallowed: a message that reached a broken destination is still a
    // message somebody is waiting on an answer to.
    expect(transport.sent()).toEqual([{ chatId: CHAT, text: ASSISTANT_UNAVAILABLE }]);
    expect(await transcript()).toEqual([
      { direction: 'inbound', text: 'watch the kettle page for me' },
      { direction: 'outbound', text: ASSISTANT_UNAVAILABLE },
    ]);
  });
});

describe('the runtime', () => {
  it('refuses to be built with nowhere to queue an answered task', () => {
    // A bot that records answers nothing will ever run is the failure the
    // whole round trip exists to prevent, so it is refused before it starts.
    expect(() =>
      createBotRuntime({
        config: configFor(),
        db: database.db,
        transformer: createTestTransport().transformer,
        botInfo: TEST_BOT_INFO,
        chatLoop: spyLoop(),
      }),
    ).toThrow('job harness');
  });
});

/** A waiting task with an `ask_user` event whose payload the writer got wrong. */
async function parkOn(userId: string, payload: Record<string, unknown>): Promise<void> {
  const [task] = await database.db
    .insert(tasks)
    .values({ userId, kind: 'cancel', input: { site: 'fakegym' }, mode: 'playbook', status: 'waiting_user' })
    .returning();
  if (task === undefined) throw new Error('the fixture task was not created');
  await database.db.insert(taskEvents).values({ taskId: task.id, type: 'ask_user', payload });
}
