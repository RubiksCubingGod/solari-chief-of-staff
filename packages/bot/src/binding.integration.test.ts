import {
  bindingCodes,
  createDatabase,
  messages,
  runMigrations,
  users,
  type Database,
} from '@chief-of-staff/db';
import { startTestPostgres, type TestPostgres } from '@chief-of-staff/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bindChat } from './binding.js';
import { loadBotConfig, type BotConfig } from './config.js';
import {
  BINDING_ALREADY_DONE,
  BINDING_CHAT_TAKEN,
  BINDING_CODE_CONSUMED,
  BINDING_CODE_EXPIRED,
  BINDING_CODE_UNKNOWN,
  BINDING_CONFIRMED,
  BINDING_USER_TAKEN,
  HOW_TO_BIND,
} from './replies.js';
import type { AnswerSink, ChatLoop } from './routing.js';
import { createBotRuntime, type BotRuntime } from './runtime.js';
import {
  TEST_BOT_INFO,
  createTestTransport,
  textUpdate,
  type TestTransport,
} from './testing/transport.js';
import type { BotDatabase } from './transcript.js';

/**
 * The authorization root, end to end: a code sitting in the table the API
 * writes, redeemed through the same `/start` a person actually sends, against a
 * real database. Every refusal is checked for what it did *not* do as well as
 * for what it said — a refusal that still bound the chat would read as a
 * refusal and behave as a takeover.
 */

/**
 * Every message in this file is a `/start`, which the runtime answers before
 * the router ever sees it - except the one that deliberately checks what the
 * message *after* binding is attributed to. This is what answers that one.
 */
const chatLoop: ChatLoop = { respond: () => Promise.resolve('noted') };

const CHAT = '70001';
const OTHER_CHAT = '70002';
const A_CODE = 'ABCDEFGHJK';
const MINUTE = 60_000;

let postgres: TestPostgres;
let database: Database;
const started: BotRuntime[] = [];

/** The transaction handle drizzle hands a `db.transaction` callback. */
type Transaction = Parameters<Parameters<BotDatabase['transaction']>[0]>[0];

async function createUser(): Promise<string> {
  const [created] = await database.db.insert(users).values({}).returning();
  if (created === undefined) throw new Error('the fixture user was not created');
  return created.id;
}

async function issueCode(
  userId: string,
  options: { code?: string; expiresInMs?: number; consumed?: boolean } = {},
): Promise<string> {
  const code = options.code ?? A_CODE;
  await database.db.insert(bindingCodes).values({
    userId,
    code,
    expiresAt: new Date(Date.now() + (options.expiresInMs ?? 10 * MINUTE)),
    ...(options.consumed === true ? { consumedAt: new Date() } : {}),
  });
  return code;
}

async function chatIdOf(userId: string): Promise<string | null> {
  const [found] = await database.db.select().from(users).where(eq(users.id, userId));
  return found?.telegramChatId ?? null;
}

async function consumedAtOf(code: string): Promise<Date | null> {
  const [found] = await database.db.select().from(bindingCodes).where(eq(bindingCodes.code, code));
  return found?.consumedAt ?? null;
}

function configFor(): BotConfig {
  return loadBotConfig({
    TELEGRAM_BOT_TOKEN: '123456:test-token',
    DATABASE_URL: postgres.connectionString,
    // High enough that nothing here is refused as a flood; the notice window is
    // what the how-to-bind reply is rationed by.
    TELEGRAM_RATE_LIMIT_BURST: '20',
    TELEGRAM_RATE_LIMIT_PER_MINUTE: '60',
    TELEGRAM_RATE_LIMIT_NOTICE_SECONDS: '60',
  });
}

/** Nothing in this file answers a question, so the runtime's ledger sink is not composed. */
const noAnswers: AnswerSink = {
  deliver: () => Promise.reject(new Error('no message in this file answers a question')),
};

function runtimeFor(transport: TestTransport, now: () => number = Date.now): BotRuntime {
  const runtime = createBotRuntime({
    config: configFor(),
    db: database.db,
    transformer: transport.transformer,
    botInfo: TEST_BOT_INFO,
    chatLoop,
    answerSink: noAnswers,
    now,
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
  await database.db.delete(bindingCodes);
  await database.db.delete(users);
});

describe('the accepted binding path', () => {
  it('binds the chat, spends the code, and says so', async () => {
    const userId = await createUser();
    const code = await issueCode(userId);
    const transport = createTestTransport();
    const runtime = runtimeFor(transport);

    await runtime.bot.handleUpdate(textUpdate(CHAT, `/start ${code}`));

    expect(transport.sent()).toEqual([{ chatId: CHAT, text: BINDING_CONFIRMED }]);
    expect(await chatIdOf(userId)).toBe(CHAT);
    expect(await consumedAtOf(code)).not.toBeNull();
  });

  it('resolves the next message from that chat to the user it bound', async () => {
    const userId = await createUser();
    const code = await issueCode(userId);
    const transport = createTestTransport();
    const runtime = runtimeFor(transport);

    await runtime.bot.handleUpdate(textUpdate(CHAT, `/start ${code}`));
    await runtime.bot.handleUpdate(textUpdate(CHAT, 'watch this page'));

    // The transcript is where a binding becomes visible to everything
    // downstream: the second message is attributed, the `/start` before it
    // could not have been.
    const rows = await database.db.select().from(messages).where(eq(messages.chatId, CHAT));
    const attributed = rows.filter((row) => row.text === 'watch this page');
    expect(attributed).toHaveLength(1);
    expect(attributed[0]?.userId).toBe(userId);
  });

  it('takes the code as it was retyped, not only as it was issued', async () => {
    const userId = await createUser();
    await issueCode(userId, { code: '0123456789' });
    const transport = createTestTransport();
    const runtime = runtimeFor(transport);

    // Lowercase, hyphenated, and with the letters people read digits as.
    await runtime.bot.handleUpdate(textUpdate(CHAT, '/start oi23-456789'));

    expect(transport.sent()).toEqual([{ chatId: CHAT, text: BINDING_CONFIRMED }]);
    expect(await chatIdOf(userId)).toBe(CHAT);
  });

  it('is idempotent when the same chat sends a second code for the same user', async () => {
    const userId = await createUser();
    const first = await issueCode(userId, { code: 'ABCDEFGHJK' });
    const second = await issueCode(userId, { code: 'MNPQRSTVWX' });
    const transport = createTestTransport();
    const runtime = runtimeFor(transport);

    await runtime.bot.handleUpdate(textUpdate(CHAT, `/start ${first}`));
    transport.clear();
    await runtime.bot.handleUpdate(textUpdate(CHAT, `/start ${second}`));

    expect(transport.sent()).toEqual([{ chatId: CHAT, text: BINDING_ALREADY_DONE }]);
    expect(await chatIdOf(userId)).toBe(CHAT);
    // Spent, not merely acknowledged: a code that survives being sent is a code
    // somebody else could still send.
    expect(await consumedAtOf(second)).not.toBeNull();
  });
});

describe('refused bindings', () => {
  it('refuses an expired code and binds nothing', async () => {
    const userId = await createUser();
    const code = await issueCode(userId, { expiresInMs: -MINUTE });
    const transport = createTestTransport();
    const runtime = runtimeFor(transport);

    await runtime.bot.handleUpdate(textUpdate(CHAT, `/start ${code}`));

    expect(transport.sent()).toEqual([{ chatId: CHAT, text: BINDING_CODE_EXPIRED }]);
    expect(await chatIdOf(userId)).toBeNull();
    expect(await consumedAtOf(code)).toBeNull();
  });

  it('refuses a code nobody was ever issued, and binds nothing', async () => {
    const userId = await createUser();
    const transport = createTestTransport();
    const runtime = runtimeFor(transport);

    await runtime.bot.handleUpdate(textUpdate(CHAT, '/start ZZZZZZZZZZ'));

    expect(transport.sent()).toEqual([{ chatId: CHAT, text: BINDING_CODE_UNKNOWN }]);
    expect(await chatIdOf(userId)).toBeNull();
  });

  it('refuses something that is not a code at all in the same words', async () => {
    const transport = createTestTransport();
    const runtime = runtimeFor(transport);

    // Answered identically to a well-formed code that does not exist: a
    // different reply here would tell a guesser when they had the shape right.
    await runtime.bot.handleUpdate(textUpdate(CHAT, '/start not-a-code'));

    expect(transport.sent()).toEqual([{ chatId: CHAT, text: BINDING_CODE_UNKNOWN }]);
  });

  it('refuses a code that has already been spent', async () => {
    const userId = await createUser();
    const code = await issueCode(userId, { consumed: true });
    const transport = createTestTransport();
    const runtime = runtimeFor(transport);

    await runtime.bot.handleUpdate(textUpdate(CHAT, `/start ${code}`));

    expect(transport.sent()).toEqual([{ chatId: CHAT, text: BINDING_CODE_CONSUMED }]);
    expect(await chatIdOf(userId)).toBeNull();
  });

  it('will not rebind a chat that already belongs to somebody else', async () => {
    const owner = await createUser();
    await issueCode(owner, { code: 'ABCDEFGHJK' });
    const stranger = await createUser();
    const strangerCode = await issueCode(stranger, { code: 'MNPQRSTVWX' });
    const transport = createTestTransport();
    const runtime = runtimeFor(transport);

    await runtime.bot.handleUpdate(textUpdate(CHAT, '/start ABCDEFGHJK'));
    transport.clear();
    await runtime.bot.handleUpdate(textUpdate(CHAT, `/start ${strangerCode}`));

    expect(transport.sent()).toEqual([{ chatId: CHAT, text: BINDING_CHAT_TAKEN }]);
    // The chat stays with its owner, and the stranger's code is still unspent:
    // a refused takeover must not even cost the stranger the code they hold.
    expect(await chatIdOf(owner)).toBe(CHAT);
    expect(await chatIdOf(stranger)).toBeNull();
    expect(await consumedAtOf(strangerCode)).toBeNull();
  });

  it('will not move a user to a second chat without an explicit unbind', async () => {
    const userId = await createUser();
    await issueCode(userId, { code: 'ABCDEFGHJK' });
    const second = await issueCode(userId, { code: 'MNPQRSTVWX' });
    const transport = createTestTransport();
    const runtime = runtimeFor(transport);

    await runtime.bot.handleUpdate(textUpdate(CHAT, '/start ABCDEFGHJK'));
    transport.clear();
    await runtime.bot.handleUpdate(textUpdate(OTHER_CHAT, `/start ${second}`));

    expect(transport.sent()).toEqual([{ chatId: OTHER_CHAT, text: BINDING_USER_TAKEN }]);
    expect(await chatIdOf(userId)).toBe(CHAT);
    expect(await consumedAtOf(second)).toBeNull();
  });
});

describe('consume and bind are one write', () => {
  it('leaves the code unspent when the binding write fails', async () => {
    const userId = await createUser();
    const code = await issueCode(userId);

    await expect(
      bindChat(crashingBetweenSteps(database.db), { chatId: CHAT, code }),
    ).rejects.toThrow(/between consume and bind/u);

    // The whole reason the two writes share a transaction: a code burned
    // without a binding is somebody locked out holding a code that no longer
    // works, and no way back except an operator.
    expect(await consumedAtOf(code)).toBeNull();
    expect(await chatIdOf(userId)).toBeNull();
  });

  it('binds normally through an unwrapped handle, so the fault was the injected one', async () => {
    const userId = await createUser();
    const code = await issueCode(userId);

    const result = await bindChat(database.db, { chatId: CHAT, code });

    expect(result).toEqual({ outcome: 'bound', userId });
  });
});

describe('an unbound chat', () => {
  it('is told how to bind, exactly once per notice window', async () => {
    let now = 1_000_000;
    const transport = createTestTransport();
    const runtime = runtimeFor(transport, () => now);

    await runtime.bot.handleUpdate(textUpdate(CHAT, 'hello?'));
    await runtime.bot.handleUpdate(textUpdate(CHAT, 'anyone there?'));
    await runtime.bot.handleUpdate(textUpdate(CHAT, 'hello???'));

    expect(transport.sent()).toEqual([{ chatId: CHAT, text: HOW_TO_BIND }]);

    now += 60 * MINUTE;
    await runtime.bot.handleUpdate(textUpdate(CHAT, 'still here'));

    // A window later it is worth saying again: somebody still trying an hour on
    // has not been told recently, and silence reads as a bot that is broken.
    expect(transport.sent()).toHaveLength(2);
  });

  it('is told how to bind when /start arrives with no code at all', async () => {
    const transport = createTestTransport();
    const runtime = runtimeFor(transport);

    await runtime.bot.handleUpdate(textUpdate(CHAT, '/start'));

    expect(transport.sent()).toEqual([{ chatId: CHAT, text: HOW_TO_BIND }]);
  });

  it('has everything it said and was told written to the transcript', async () => {
    const transport = createTestTransport();
    const runtime = runtimeFor(transport);

    await runtime.bot.handleUpdate(textUpdate(CHAT, 'hello?'));

    const rows = await database.db.select().from(messages).where(eq(messages.chatId, CHAT));
    expect(rows.map((row) => [row.direction, row.text])).toEqual([
      ['inbound', 'hello?'],
      ['outbound', HOW_TO_BIND],
    ]);
    // Nobody to attribute either row to, and both rows kept regardless.
    expect(rows.every((row) => row.userId === null)).toBe(true);
  });

  it('never reaches whatever handles a bound chat', async () => {
    const transport = createTestTransport();
    const runtime = runtimeFor(transport);
    let reached = false;
    runtime.bot.use(() => {
      reached = true;
      return Promise.resolve();
    });

    await runtime.bot.handleUpdate(textUpdate(CHAT, 'do something for me'));

    expect(reached).toBe(false);
  });
});

/**
 * A database handle that does everything asked of it inside a transaction until
 * the binding row itself is written, then fails the way a process dying between
 * the two writes would. Injected from outside rather than through a seam in
 * `bindChat`, so what the proof exercises is the real code path.
 */
function crashingBetweenSteps(db: BotDatabase): BotDatabase {
  return new Proxy(db, {
    get(target, property, receiver): unknown {
      const value: unknown = Reflect.get(target, property, receiver);
      if (property !== 'transaction' || typeof value !== 'function') return value;
      return async (callback: (tx: Transaction) => Promise<unknown>): Promise<unknown> =>
        target.transaction(async (tx) => callback(failingOnUserWrite(tx)));
    },
  });
}

function failingOnUserWrite(tx: Transaction): Transaction {
  return new Proxy(tx, {
    get(target, property, receiver): unknown {
      const value: unknown = Reflect.get(target, property, receiver);
      if (property !== 'update' || typeof value !== 'function') return value;
      return (table: unknown): unknown => {
        if (table === users) throw new Error('injected crash between consume and bind');
        return (value as (argument: unknown) => unknown).call(target, table);
      };
    },
  });
}
