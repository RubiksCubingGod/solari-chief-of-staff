import {
  createDatabase,
  deliveries,
  messages,
  runMigrations,
  users,
  type Database,
  type Delivery,
} from '@chief-of-staff/db';
import { startTestPostgres, type TestPostgres } from '@chief-of-staff/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadBotConfig, type BotConfig } from './config.js';
import {
  NoBindingError,
  createSendToUser,
  type ChatSender,
  type SendRetryPolicy,
} from './outbound.js';
import type { ChatLoop } from './routing.js';
import { createBotRuntime, type BotRuntime } from './runtime.js';
import {
  TEST_BOT_INFO,
  createTestTransport,
  type SendOutcome,
  type TestTransport,
} from './testing/transport.js';

/**
 * The single outbound door, against a real database.
 *
 * Everything here is about the gap between "we tried to say something" and "the
 * user has it". A notification that never arrives is the failure this sprint's
 * consumers — reminders in s7, red-run alerts in s9 — cannot afford to be
 * silent, so every test below asserts the delivery row as well as the wire.
 */

const CHAT = '80001';
const A_MESSAGE = 'Your gym membership renews on Friday.';
/** Two attempts and a short pause, so the backoff is two assertable numbers. */
const RETRY: SendRetryPolicy = { attempts: 3, backoffMs: 100 };

let postgres: TestPostgres;
let database: Database;
const started: BotRuntime[] = [];

async function createUser(chatId: string | null = CHAT): Promise<string> {
  const [created] = await database.db
    .insert(users)
    .values(chatId === null ? {} : { telegramChatId: chatId })
    .returning();
  if (created === undefined) throw new Error('the fixture user was not created');
  return created.id;
}

async function deliveriesOf(userId: string): Promise<Delivery[]> {
  return database.db.select().from(deliveries).where(eq(deliveries.userId, userId));
}

async function outboundTextsOf(chatId: string): Promise<string[]> {
  const rows = await database.db.select().from(messages).where(eq(messages.chatId, chatId));
  return rows.filter((row) => row.direction === 'outbound').map((row) => row.text);
}

const unreachableLoop: ChatLoop = {
  respond: () => Promise.reject(new Error('no inbound message in this file reaches the chat loop')),
};

function configFor(): BotConfig {
  return loadBotConfig({
    TELEGRAM_BOT_TOKEN: '123456:test-token',
    DATABASE_URL: postgres.connectionString,
  });
}

function runtimeFor(transport: TestTransport, waits: number[] = []): BotRuntime {
  const runtime = createBotRuntime({
    config: configFor(),
    db: database.db,
    transformer: transport.transformer,
    botInfo: TEST_BOT_INFO,
    // Nothing here sends the bot a message: this file is about the outbound
    // door. The loop is present because the runtime requires one, and it is
    // never called.
    chatLoop: unreachableLoop,
    sendRetry: RETRY,
    wait: async (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
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
  await database.db.delete(deliveries);
  await database.db.delete(messages);
  await database.db.delete(users);
});

describe('a message that gets through', () => {
  it('reaches the chat the user is bound to, and records the delivery', async () => {
    const userId = await createUser();
    const transport = createTestTransport();
    const runtime = runtimeFor(transport);

    const delivery = await runtime.sendToUser(userId, A_MESSAGE);

    expect(transport.sent()).toEqual([{ chatId: CHAT, text: A_MESSAGE }]);
    expect(delivery).toMatchObject({
      userId,
      chatId: CHAT,
      text: A_MESSAGE,
      status: 'sent',
      attempts: 1,
      error: null,
    });
    // Settled is what tells a stuck row from a finished one, so it has to be
    // set by the same write that sets the status.
    expect(delivery.settledAt).not.toBeNull();
    expect(await deliveriesOf(userId)).toHaveLength(1);
  });

  it('transcribes what it delivered, through the same door every reply uses', async () => {
    const userId = await createUser();
    const runtime = runtimeFor(createTestTransport());

    await runtime.sendToUser(userId, A_MESSAGE);

    // sendToUser writes no transcript row of its own: it sends through the
    // runtime, and the runtime transcribes every outbound call. A second row
    // here would mean the two paths had drifted apart.
    expect(await outboundTextsOf(CHAT)).toEqual([A_MESSAGE]);
  });
});

describe('a user there is nowhere to send to', () => {
  it('refuses a user no chat is bound to, and records no delivery', async () => {
    const userId = await createUser(null);
    const transport = createTestTransport();
    const runtime = runtimeFor(transport);

    await expect(runtime.sendToUser(userId, A_MESSAGE)).rejects.toThrow(NoBindingError);

    expect(transport.sent()).toEqual([]);
    // Nothing was attempted, so there is no attempt to record. The caller holds
    // the fact instead, as a typed error it cannot mistake for success.
    expect(await deliveriesOf(userId)).toEqual([]);
  });

  it('refuses a user id that matches nobody, in the same words', async () => {
    const runtime = runtimeFor(createTestTransport());
    const nobody = '00000000-0000-4000-8000-000000000000';

    await expect(runtime.sendToUser(nobody, A_MESSAGE)).rejects.toThrow(NoBindingError);
  });

  it('names the user it could not reach, so a fan-out can say which one failed', async () => {
    const userId = await createUser(null);
    const runtime = runtimeFor(createTestTransport());

    await expect(runtime.sendToUser(userId, A_MESSAGE)).rejects.toMatchObject({ userId });
  });
});

describe('a send Telegram refuses', () => {
  /** What Telegram answers when the person has blocked the bot. */
  const BLOCKED: SendOutcome = {
    kind: 'refused',
    errorCode: 403,
    description: 'Forbidden: bot was blocked by the user',
  };
  /** What it answers when its own side is having a bad minute. */
  const SERVER_ERROR: SendOutcome = {
    kind: 'refused',
    errorCode: 500,
    description: 'Internal Server Error',
  };

  it('records a failed delivery without retrying a refusal that cannot change', async () => {
    const userId = await createUser();
    const transport = createTestTransport();
    transport.scriptSends(BLOCKED, BLOCKED, BLOCKED);
    const runtime = runtimeFor(transport);

    const delivery = await runtime.sendToUser(userId, A_MESSAGE);

    // A blocked bot is still blocked on the third try. Spending the budget on
    // it delays every other delivery behind it for nothing.
    expect(transport.callsTo('sendMessage')).toHaveLength(1);
    expect(delivery).toMatchObject({ status: 'failed', attempts: 1 });
    expect(delivery.error).toContain('bot was blocked by the user');
    expect(delivery.settledAt).not.toBeNull();
  });

  it('leaves no transcript row for a message the user never received', async () => {
    const userId = await createUser();
    const transport = createTestTransport();
    transport.scriptSends(BLOCKED);
    const runtime = runtimeFor(transport);

    await runtime.sendToUser(userId, A_MESSAGE);

    // The transcript is what the user was told. Writing a failed send into it
    // would show them, and us, a conversation that did not happen.
    expect(await outboundTextsOf(CHAT)).toEqual([]);
  });

  it('retries a failure that might pass, and records the delivery that follows', async () => {
    const userId = await createUser();
    const transport = createTestTransport();
    transport.scriptSends(SERVER_ERROR);
    const runtime = runtimeFor(transport);

    const delivery = await runtime.sendToUser(userId, A_MESSAGE);

    expect(transport.callsTo('sendMessage')).toHaveLength(2);
    expect(transport.sent()).toEqual([{ chatId: CHAT, text: A_MESSAGE }]);
    expect(delivery).toMatchObject({ status: 'sent', attempts: 2, error: null });
  });

  it('gives up when the policy runs out, and keeps the last thing it was told', async () => {
    const userId = await createUser();
    const transport = createTestTransport();
    transport.scriptSends(SERVER_ERROR, SERVER_ERROR, SERVER_ERROR);
    const runtime = runtimeFor(transport);

    const delivery = await runtime.sendToUser(userId, A_MESSAGE);

    expect(transport.callsTo('sendMessage')).toHaveLength(RETRY.attempts);
    expect(delivery).toMatchObject({ status: 'failed', attempts: RETRY.attempts });
    expect(delivery.error).toContain('Internal Server Error');
  });

  it('backs off further after each failure', async () => {
    const userId = await createUser();
    const transport = createTestTransport();
    transport.scriptSends(SERVER_ERROR, SERVER_ERROR, SERVER_ERROR);
    const waits: number[] = [];
    const runtime = runtimeFor(transport, waits);

    await runtime.sendToUser(userId, A_MESSAGE);

    // One pause between attempts and none after the last: waiting after giving
    // up delays the caller for a retry that is never coming.
    expect(waits).toEqual([RETRY.backoffMs, RETRY.backoffMs * 2]);
  });

  it('retries a transport that never reached Telegram at all', async () => {
    const userId = await createUser();
    const transport = createTestTransport();
    transport.scriptSends({ kind: 'unreachable', message: 'socket hang up' });
    const runtime = runtimeFor(transport);

    const delivery = await runtime.sendToUser(userId, A_MESSAGE);

    // No error code came back because nothing answered. That is the case a
    // second attempt exists for, so it must not be classified as terminal.
    expect(delivery).toMatchObject({ status: 'sent', attempts: 2 });
  });
});

describe('a delivery still in flight', () => {
  it('is already a pending row while the send is happening', async () => {
    const userId = await createUser();
    let seen: Delivery[] = [];
    // Reads the table from inside the send, which is the only moment the
    // in-flight row exists. A process killed here leaves that row behind
    // instead of leaving no trace that a notification was ever owed.
    const probe: ChatSender = {
      send: async (): Promise<{ ok: true }> => {
        seen = await deliveriesOf(userId);
        return { ok: true };
      },
    };

    await createSendToUser({ db: database.db, sender: probe })(userId, A_MESSAGE);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ status: 'pending', attempts: 0, error: null });
    expect(seen[0]?.settledAt).toBeNull();
  });
});
