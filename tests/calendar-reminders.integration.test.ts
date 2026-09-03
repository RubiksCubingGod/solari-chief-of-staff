import { randomUUID } from 'node:crypto';

import { createHttpCrudClient, type CrudClient } from '@chief-of-staff/agent';
import { createApp, mintSessionCookie } from '@chief-of-staff/api';
import { createReminderSender, createTelegramOutbound, loadBotConfig } from '@chief-of-staff/bot';
import {
  CALENDAR_SCAN_QUEUE,
  calendarReminders,
  createJobHarness,
  deliveries,
  messages,
  registerCalendarScan,
  runCalendarScan,
  runMigrations,
  runWorker,
  users,
  type JobHarness,
} from '@chief-of-staff/db';
import { startTestPostgres, type TestPostgres } from '@chief-of-staff/db/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createTestTransport, type TestTransport } from '../packages/bot/src/testing/transport.js';

/**
 * The reminder path, composed the way the worker composes it.
 *
 * An entry created through the chat agent's own HTTP tool client - the same
 * `POST /calendar-items` a "remind me about the gym" ends in - is found by the
 * scan running on a pg-boss harness, and goes out through the bot's outbound
 * door over grammY to the message Telegram would have received. The assertions
 * are at the ends: the text on the wire, and the rows the dashboard reads -
 * the delivery, the reminder that points at it, and the transcript.
 *
 * Only the Telegram network is stood in for, at the API transformer. The scan
 * module's own proofs script the send port instead; this file is what says
 * the port, the door and the transport are wired to each other.
 */

let postgres: TestPostgres;
let app: ReturnType<typeof createApp>;
let crud: CrudClient;
let transport: TestTransport;
const started: JobHarness[] = [];

const SESSION_SECRET = 'the-secret-this-suite-configured';
const BOUND_CHAT = '88001';
const LEAD_DAY_AFTERNOON = () => new Date('2026-09-09T15:00:00Z');

beforeAll(async () => {
  postgres = await startTestPostgres();
  await runMigrations(postgres.connectionString);
  app = createApp({
    DATABASE_URL: postgres.connectionString,
    LOG_LEVEL: 'silent',
    SESSION_SECRET,
  });
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  crud = createHttpCrudClient({
    baseUrl,
    credential: (caller) => ({ cookie: mintSessionCookie(caller, SESSION_SECRET) }),
  });
  transport = createTestTransport();
});

afterEach(async () => {
  for (const harness of started.splice(0)) await harness.stop();
  transport.clear();
  await app.db.delete(users);
});

afterAll(async () => {
  try {
    await app.close();
  } finally {
    await postgres.stop();
  }
});

/** The worker's outbound door: the bot's, without a bot listening. */
function outbound() {
  return createTelegramOutbound({
    config: loadBotConfig({
      TELEGRAM_BOT_TOKEN: 'test-token',
      DATABASE_URL: postgres.connectionString,
    }),
    db: app.db,
    transformer: transport.transformer,
  });
}

async function insertUser(telegramChatId?: string): Promise<string> {
  const [user] = await app.db
    .insert(users)
    .values({ email: `${randomUUID()}@example.test`, telegramChatId, tz: 'UTC' })
    .returning();
  if (user === undefined) throw new Error('the user insert returned no row');
  return user.id;
}

describe('a reminder, end to end', () => {
  it('goes from the chat tool’s entry to the message in the chat, once', async () => {
    const userId = await insertUser(BOUND_CHAT);
    const created = await crud.request(userId, 'POST', '/calendar-items', {
      kind: 'subscription',
      name: 'Gym',
      amountCents: 4500,
      renewOn: '2026-09-12',
    });
    if (!created.ok) throw new Error(`the entry was refused: ${created.reason}`);
    expect(created.status).toBe(201);
    const itemId = (created.body as { id: string }).id;

    const send = createReminderSender(outbound());
    const harness = createJobHarness({
      connectionString: postgres.connectionString,
      schema: `pgboss_${randomUUID().slice(0, 8)}`,
      pollingIntervalSeconds: 0.5,
    });
    started.push(harness);
    await runWorker(harness, [
      registerCalendarScan({ db: app.db, send, now: LEAD_DAY_AFTERNOON }),
    ]);

    await vi.waitFor(() => expect(transport.sent()).toHaveLength(1), { timeout: 10_000 });
    expect(transport.sent()).toEqual([
      {
        chatId: BOUND_CHAT,
        text: 'Reminder: Gym renews on 2026-09-12 (in 3 days). Amount: 45.00.',
      },
    ]);

    const [delivery] = await app.db.select().from(deliveries);
    expect(delivery).toMatchObject({ chatId: BOUND_CHAT, status: 'sent', attempts: 1 });
    const [reminder] = await app.db.select().from(calendarReminders);
    expect(reminder).toMatchObject({
      itemId,
      dueOn: '2026-09-09',
      state: 'delivered',
      deliveryId: delivery?.id,
    });
    // Transcribed like every other outbound message, by the same row of code.
    const transcript = await app.db
      .select({ chatId: messages.chatId, direction: messages.direction, text: messages.text })
      .from(messages);
    expect(transcript).toMatchObject([{ chatId: BOUND_CHAT, direction: 'outbound' }]);
    expect(transcript[0]?.text).toContain('Gym renews');

    // The next hour's scan, on the same day.
    const again = await runCalendarScan({ db: app.db, send, now: LEAD_DAY_AFTERNOON });

    expect(again).toEqual({ due: 1, delivered: 0, late: 0, failed: 0, skipped: 0, enqueued: 0, unlinked: 0, settled: 0 });
    expect(transport.sent()).toHaveLength(1);
    expect(await harness.schedules(CALENDAR_SCAN_QUEUE)).toHaveLength(1);
  });

  it('records what Telegram said when the send fails, on the delivery and on the reminder', async () => {
    const userId = await insertUser(BOUND_CHAT);
    await crud.request(userId, 'POST', '/calendar-items', {
      kind: 'deadline',
      name: 'Taxes',
      cancelBy: '2026-09-12',
    });
    // Blocked for good: the door does not retry a 403, and the scan should
    // have the words Telegram used rather than a summary of them.
    transport.scriptSends({
      kind: 'refused',
      errorCode: 403,
      description: 'Forbidden: bot was blocked by the user',
    });
    const send = createReminderSender(outbound());

    const report = await runCalendarScan({ db: app.db, send, now: LEAD_DAY_AFTERNOON });

    expect(report).toEqual({ due: 1, delivered: 0, late: 0, failed: 1, skipped: 0, enqueued: 0, unlinked: 0, settled: 0 });
    expect(transport.sent()).toEqual([]);
    const [delivery] = await app.db.select().from(deliveries);
    expect(delivery).toMatchObject({ status: 'failed' });
    const [reminder] = await app.db.select().from(calendarReminders);
    expect(reminder).toMatchObject({ state: 'failed', attempts: 1, deliveryId: delivery?.id });
    expect(reminder?.error).toContain('bot was blocked by the user');
  });

  it('records a skip for a person the dashboard knows but Telegram does not', async () => {
    const userId = await insertUser();
    await crud.request(userId, 'POST', '/calendar-items', {
      kind: 'subscription',
      name: 'Gym',
      renewOn: '2026-09-12',
    });

    const report = await runCalendarScan({
      db: app.db,
      send: createReminderSender(outbound()),
      now: LEAD_DAY_AFTERNOON,
    });

    expect(report).toEqual({ due: 1, delivered: 0, late: 0, failed: 0, skipped: 1, enqueued: 0, unlinked: 0, settled: 0 });
    expect(transport.calls).toEqual([]);
    expect(await app.db.select().from(deliveries)).toEqual([]);
    const [reminder] = await app.db.select().from(calendarReminders);
    expect(reminder).toMatchObject({ state: 'skipped_unbound', deliveryId: null });
  });
});
