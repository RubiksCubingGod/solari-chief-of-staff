import {
  createDatabase,
  messages,
  runMigrations,
  taskEvents,
  tasks,
  users,
  type Database,
} from '@chief-of-staff/db';
import { startTestPostgres, type TestPostgres } from '@chief-of-staff/db/testing';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadBotConfig, type BotConfig } from './config.js';
import { ANSWER_RECORDED, ASSISTANT_UNAVAILABLE, HOW_TO_BIND } from './replies.js';
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
 * Every test here asserts both halves — what the message reached and what it
 * did not — because the failure this router exists to prevent is not a message
 * going to the wrong place. It is a message going to both places, which books
 * an appointment out of an answer, or to neither, which loses it silently.
 */

const CHAT = '80001';
const OTHER_CHAT = '80002';

let postgres: TestPostgres;
let database: Database;
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

/** A sink that records what it was handed instead of writing the reply event. */
function spySink(): AnswerSink & { readonly seen: QuestionAnswer[] } {
  const seen: QuestionAnswer[] = [];
  return {
    seen,
    deliver(answer: QuestionAnswer): Promise<void> {
      seen.push(answer);
      return Promise.resolve();
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

/** A task parked on a question, which is the only state an answer can exist in. */
async function askQuestion(userId: string, question: string): Promise<string> {
  const [task] = await database.db
    .insert(tasks)
    .values({
      userId,
      kind: 'cancel',
      input: { what: 'the gym membership' },
      mode: 'playbook',
      status: 'waiting_user',
    })
    .returning();
  if (task === undefined) throw new Error('the fixture task was not created');
  await database.db.insert(taskEvents).values({
    taskId: task.id,
    type: 'ask_user',
    payload: { question },
  });
  return task.id;
}

async function eventsOf(taskId: string): Promise<{ type: string; payload: unknown }[]> {
  const rows = await database.db
    .select({ type: taskEvents.type, payload: taskEvents.payload, ts: taskEvents.ts })
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    .orderBy(asc(taskEvents.ts));
  return rows.map((row) => ({ type: row.type, payload: row.payload }));
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
});

afterAll(async () => {
  try {
    await Promise.all(started.splice(0).map((runtime) => runtime.stop()));
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
    const taskId = await askQuestion(userId, 'Which membership should I cancel?');
    const transport = createTestTransport();
    const loop = spyLoop();
    const sink = spySink();
    const runtime = runtimeFor(transport, loop, sink);

    await runtime.bot.handleUpdate(textUpdate(CHAT, 'the annual one, please'));

    expect(sink.seen).toEqual([
      {
        userId,
        taskId,
        question: 'Which membership should I cancel?',
        text: 'the annual one, please',
      },
    ]);
    // The other destination, asserted empty. Either assertion alone would pass
    // for a message that went to both.
    expect(loop.seen).toEqual([]);
    expect(transport.sent()).toEqual([{ chatId: CHAT, text: ANSWER_RECORDED }]);
  });

  it('records the answer where the task engine will read it back', async () => {
    const userId = await createUser(CHAT);
    const taskId = await askQuestion(userId, 'Which membership should I cancel?');
    const transport = createTestTransport();
    const runtime = runtimeFor(transport, spyLoop());

    await runtime.bot.handleUpdate(textUpdate(CHAT, 'the annual one, please'));

    // The default sink is not a stub: it writes the reply onto the task
    // timeline, which is the seam the engine in a later sprint reads. What is
    // stubbed in this sprint is the reader, not the record.
    expect(await eventsOf(taskId)).toEqual([
      { type: 'ask_user', payload: { question: 'Which membership should I cancel?' } },
      { type: 'user_reply', payload: { text: 'the annual one, please' } },
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
      input: { what: 'the gym membership' },
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
    const [task] = await database.db
      .insert(tasks)
      .values({
        userId,
        kind: 'cancel',
        input: { what: 'the gym membership' },
        mode: 'playbook',
        status: 'waiting_user',
      })
      .returning();
    await database.db.insert(taskEvents).values({
      taskId: task?.id ?? '',
      type: 'ask_user',
      // A payload the writer got wrong, which is the only way this happens.
      payload: { prompt: 'Which membership should I cancel?' },
    });
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

  it('answers the most recent question when two jobs are waiting at once', async () => {
    const userId = await createUser(CHAT);
    await askQuestion(userId, 'Which membership should I cancel?');
    const newerTaskId = await askQuestion(userId, 'Which of the two cards should I use?');
    const transport = createTestTransport();
    const sink = spySink();
    const runtime = runtimeFor(transport, spyLoop(), sink);

    await runtime.bot.handleUpdate(textUpdate(CHAT, 'the second one'));

    // Nothing in the words says which job is being answered. The newest
    // question is the one still on the user's screen, so it is the one their
    // next message is about.
    expect(sink.seen.map((answer) => answer.taskId)).toEqual([newerTaskId]);
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
