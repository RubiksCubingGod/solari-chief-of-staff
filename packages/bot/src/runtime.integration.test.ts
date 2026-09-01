import { createDatabase, messages, runMigrations, users, type Database } from '@chief-of-staff/db';
import { startTestPostgres, type TestPostgres } from '@chief-of-staff/db/testing';
import { asc } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadBotConfig, type BotConfig } from './config.js';
import { HOW_TO_BIND, RATE_LIMIT_NOTICE } from './replies.js';
import type { ChatLoop } from './routing.js';
import { createBotRuntime, type BotRuntime } from './runtime.js';
import { TEST_BOT_INFO, createTestTransport, textUpdate, type TestTransport } from './testing/transport.js';

/**
 * The bot runtime against a real database and a test transport: no network, no
 * live bot, no Telegram token that has to exist. What is proven here is what
 * `done_when` asks for — both transports boot, every message in either
 * direction lands in the transcript including the refused ones, and a flood is
 * refused with exactly one notice per window.
 */

/**
 * What the chat loop says here. This file is about the machinery a message
 * crosses before it reaches a destination, so the destination is a constant:
 * every reply below that is this string is the runtime having got the message
 * all the way through.
 */
const LOOP_REPLY = 'noted';
const chatLoop: ChatLoop = { respond: () => Promise.resolve(LOOP_REPLY) };

const BOUND_CHAT = '90001';
const UNBOUND_CHAT = '90002';
const SECOND_BOUND_CHAT = '90003';

let postgres: TestPostgres;
let database: Database;
let boundUserId: string;
let secondUserId: string;
const started: BotRuntime[] = [];

const BASE_ENVIRONMENT = {
  TELEGRAM_BOT_TOKEN: '123456:test-token',
  // A burst of two makes a flood three messages long instead of eleven.
  TELEGRAM_RATE_LIMIT_BURST: '2',
  TELEGRAM_RATE_LIMIT_PER_MINUTE: '60',
  TELEGRAM_RATE_LIMIT_NOTICE_SECONDS: '60',
} as const;

function configFor(extra: NodeJS.ProcessEnv = {}): BotConfig {
  return loadBotConfig({
    ...BASE_ENVIRONMENT,
    DATABASE_URL: postgres.connectionString,
    ...extra,
  });
}

/** A runtime wired to the test transport, stopped for the test automatically. */
function runtimeFor(
  config: BotConfig,
  transport: TestTransport,
  now: () => number = Date.now,
): BotRuntime {
  const runtime = createBotRuntime({
    config,
    db: database.db,
    transformer: transport.transformer,
    botInfo: TEST_BOT_INFO,
    chatLoop,
    now,
  });
  started.push(runtime);
  return runtime;
}

async function transcript(): Promise<{ direction: string; chatId: string | null; text: string; userId: string | null }[]> {
  const rows = await database.db.select().from(messages).orderBy(asc(messages.ts), asc(messages.id));
  return rows.map((row) => ({
    direction: row.direction,
    chatId: row.chatId,
    text: row.text,
    userId: row.userId,
  }));
}

async function createUser(telegramChatId: string): Promise<string> {
  const [created] = await database.db.insert(users).values({ telegramChatId }).returning();
  if (created === undefined) throw new Error('the fixture user was not created');
  return created.id;
}

beforeAll(async () => {
  postgres = await startTestPostgres();
  await runMigrations(postgres.connectionString);
  database = createDatabase(postgres.connectionString);
  boundUserId = await createUser(BOUND_CHAT);
  secondUserId = await createUser(SECOND_BOUND_CHAT);
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
});

describe('transport configuration', () => {
  it('long-polls when configured to, and registers no webhook', async () => {
    const transport = createTestTransport();
    const runtime = runtimeFor(configFor(), transport);

    expect(runtime.transport).toBe('polling');
    await runtime.start();
    await pollReached(transport);
    await runtime.stop();

    expect(transport.callsTo('setWebhook')).toEqual([]);
    expect(transport.callsTo('getUpdates').length).toBeGreaterThan(0);
  });

  it('reports a long poll that dies after the bot is already running', async () => {
    const failures: unknown[] = [];
    const transport = createTestTransport();
    transport.failPolling(401, 'Unauthorized');
    const runtime = createBotRuntime({
      config: configFor(),
      db: database.db,
      transformer: transport.transformer,
      botInfo: TEST_BOT_INFO,
      chatLoop,
      onPollingFailure: (error) => failures.push(error),
    });
    started.push(runtime);

    // `start()` resolves as soon as the poll is running, so it cannot report
    // this: a revoked token is discovered later, and from then on the process
    // is up, healthy by every other measure, and deaf. Somebody has to be told.
    await runtime.start();
    await vi.waitFor(() => {
      expect(failures).toHaveLength(1);
    });

    expect(String(failures[0])).toContain('Unauthorized');
  });

  it('registers the webhook when configured to, and never polls', async () => {
    const transport = createTestTransport();
    const runtime = runtimeFor(
      configFor({
        TELEGRAM_TRANSPORT: 'webhook',
        TELEGRAM_WEBHOOK_URL: 'https://bot.example/telegram',
        TELEGRAM_WEBHOOK_SECRET: 'shh',
      }),
      transport,
    );

    expect(runtime.transport).toBe('webhook');
    await runtime.start();

    expect(transport.callsTo('setWebhook')).toEqual([
      { method: 'setWebhook', payload: { url: 'https://bot.example/telegram', secret_token: 'shh' } },
    ]);
    expect(transport.callsTo('getUpdates')).toEqual([]);
    // The handler production mounts exists, which is the half of "webhook
    // ready" that registering a URL does not cover.
    expect(typeof runtime.webhookHandler()).toBe('function');
  });

  it('refuses to hand out a webhook handler while it is polling', () => {
    const runtime = runtimeFor(configFor(), createTestTransport());

    expect(() => runtime.webhookHandler()).toThrow(/configured for polling/u);
  });
});

describe('transcript persistence', () => {
  it('records an inbound message against the user its chat is bound to', async () => {
    const transport = createTestTransport();
    const runtime = runtimeFor(configFor(), transport);

    await runtime.bot.handleUpdate(textUpdate(BOUND_CHAT, 'watch this page for me'));

    // Both halves: the message in, and the answer the router got for it. A
    // bound chat with tokens left is answered, which is what makes the pair a
    // readable exchange rather than a log of arrivals.
    expect(await transcript()).toEqual([
      { direction: 'inbound', chatId: BOUND_CHAT, text: 'watch this page for me', userId: boundUserId },
      { direction: 'outbound', chatId: BOUND_CHAT, text: LOOP_REPLY, userId: boundUserId },
    ]);
  });

  it('records a message from an unbound chat rather than dropping it', async () => {
    const transport = createTestTransport();
    const runtime = runtimeFor(configFor(), transport);

    await runtime.bot.handleUpdate(textUpdate(UNBOUND_CHAT, 'hello?'));

    // Nobody to attribute either row to, and both rows kept: how somebody
    // failed to bind is exactly the exchange worth being able to read back.
    expect(await transcript()).toEqual([
      { direction: 'inbound', chatId: UNBOUND_CHAT, text: 'hello?', userId: null },
      { direction: 'outbound', chatId: UNBOUND_CHAT, text: HOW_TO_BIND, userId: null },
    ]);
  });

  it('records every outbound message, whoever sent it', async () => {
    const transport = createTestTransport();
    const runtime = runtimeFor(configFor(), transport);

    await runtime.bot.api.sendMessage(Number(BOUND_CHAT), 'your watch is live');

    expect(transport.sent()).toEqual([{ chatId: BOUND_CHAT, text: 'your watch is live' }]);
    expect(await transcript()).toEqual([
      { direction: 'outbound', chatId: BOUND_CHAT, text: 'your watch is live', userId: boundUserId },
    ]);
  });
});

describe('rate limiting', () => {
  it('refuses a flood with one notice per window and transcribes all of it', async () => {
    const transport = createTestTransport();
    // Frozen: the burst cannot refill underneath the assertions.
    const runtime = runtimeFor(configFor(), transport, () => 1_000_000);

    for (const text of ['one', 'two', 'three', 'four', 'five']) {
      await runtime.bot.handleUpdate(textUpdate(BOUND_CHAT, text));
    }

    // Two allowed by the burst and answered, three refused, and exactly one
    // notice for the three — not one each.
    expect(transport.sent()).toEqual([
      { chatId: BOUND_CHAT, text: LOOP_REPLY },
      { chatId: BOUND_CHAT, text: LOOP_REPLY },
      { chatId: BOUND_CHAT, text: RATE_LIMIT_NOTICE },
    ]);
    expect(await transcript()).toEqual([
      { direction: 'inbound', chatId: BOUND_CHAT, text: 'one', userId: boundUserId },
      { direction: 'outbound', chatId: BOUND_CHAT, text: LOOP_REPLY, userId: boundUserId },
      { direction: 'inbound', chatId: BOUND_CHAT, text: 'two', userId: boundUserId },
      { direction: 'outbound', chatId: BOUND_CHAT, text: LOOP_REPLY, userId: boundUserId },
      { direction: 'inbound', chatId: BOUND_CHAT, text: 'three', userId: boundUserId },
      { direction: 'outbound', chatId: BOUND_CHAT, text: RATE_LIMIT_NOTICE, userId: boundUserId },
      // Refused and silent, but still on the record.
      { direction: 'inbound', chatId: BOUND_CHAT, text: 'four', userId: boundUserId },
      { direction: 'inbound', chatId: BOUND_CHAT, text: 'five', userId: boundUserId },
    ]);
  });

  it('meters each chat separately, so one flood cannot mute another chat', async () => {
    const transport = createTestTransport();
    const runtime = runtimeFor(configFor(), transport, () => 1_000_000);

    for (const text of ['one', 'two', 'three']) {
      await runtime.bot.handleUpdate(textUpdate(BOUND_CHAT, text));
    }
    transport.clear();
    await runtime.bot.handleUpdate(textUpdate(SECOND_BOUND_CHAT, 'am I still allowed?'));

    // Answered, not refused: the other chat spent its own burst, and this one
    // still has its tokens. A limiter that metered globally would have gone
    // quiet here instead.
    expect(transport.sent()).toEqual([{ chatId: SECOND_BOUND_CHAT, text: LOOP_REPLY }]);
    expect(await transcript()).toContainEqual({
      direction: 'inbound',
      chatId: SECOND_BOUND_CHAT,
      text: 'am I still allowed?',
      userId: secondUserId,
    });
  });
});

/** Waits for the polling loop to actually ask Telegram for updates. */
async function pollReached(transport: TestTransport): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (transport.callsTo('getUpdates').length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the polling loop never called getUpdates');
}
