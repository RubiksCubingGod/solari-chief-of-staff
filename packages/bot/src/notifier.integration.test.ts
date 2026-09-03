import type { NotifierPort, TriggeredEvent, WatchEvent } from '@chief-of-staff/core';
import { createDatabase, deliveries, runMigrations, users, type Database, type Delivery } from '@chief-of-staff/db';
import { startTestPostgres, type TestPostgres } from '@chief-of-staff/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTelegramNotifier, renderWatchEvent } from './notifier.js';
import { createSendToUser, type ChatSender, type SendAttempt, type SendToUser } from './outbound.js';

/**
 * The notifier port over the real outbound door: a keyed send is one
 * delivery row and one message however many times the event is emitted, a
 * failed one is retried on its own row by the next emission, and an unkeyed
 * send is the delivery-per-call it always was. The wire is a recording chat
 * sender: nothing here knows what Telegram is, and nothing needs to.
 */

const CHAT = '80002';

let postgres: TestPostgres;
let database: Database;

beforeAll(async () => {
  postgres = await startTestPostgres();
  await runMigrations(postgres.connectionString);
  database = createDatabase(postgres.connectionString);
});

afterAll(async () => {
  try {
    await database.close();
  } finally {
    await postgres.stop();
  }
});

beforeEach(async () => {
  // Deliveries first: they point at the users, and a chat id is bound once.
  await database.db.delete(deliveries);
  await database.db.delete(users);
});

async function createUser(chatId: string | null = CHAT): Promise<string> {
  const [created] = await database.db
    .insert(users)
    .values(chatId === null ? {} : { telegramChatId: chatId })
    .returning();
  if (created === undefined) throw new Error('the fixture user was not created');
  return created.id;
}

function deliveriesOf(userId: string): Promise<Delivery[]> {
  return database.db.select().from(deliveries).where(eq(deliveries.userId, userId));
}

/** A wire that records what it was asked to send and answers as told. */
interface Wire extends ChatSender {
  readonly sent: { chatId: string; text: string }[];
  answer: SendAttempt;
}

function wire(): Wire {
  const sent: Wire['sent'] = [];
  return {
    sent,
    answer: { ok: true },
    send(chatId, text) {
      sent.push({ chatId, text });
      return Promise.resolve(this.answer);
    },
  };
}

function doorOver(sender: ChatSender): SendToUser {
  return createSendToUser({ db: database.db, sender, retry: { attempts: 1, backoffMs: 0 } });
}

function recording(): NotifierPort & { readonly events: WatchEvent[] } {
  const events: WatchEvent[] = [];
  return {
    events,
    notify(event) {
      events.push(event);
      return Promise.resolve();
    },
  };
}

function triggered(userId: string, dedupKey: string): TriggeredEvent {
  return {
    type: 'triggered',
    watchId: 'watch-1',
    userId,
    url: 'https://shop.test/item/1',
    occurredAt: '2026-09-03T08:00:00.000Z',
    dedupKey,
    kind: 'price',
    condition: { kind: 'price', drops_below: 15, rises_above: null },
    previous: null,
    current: { kind: 'price', amount: 14.99, currency: 'USD', raw: '$14.99' },
    reason: 'price 14.99 drops below 15',
  };
}

describe('the Telegram notifier over the outbound door', () => {
  it('delivers an event emitted twice once: one row under its key, one message on the wire', async () => {
    const userId = await createUser();
    const sender = wire();
    const notifier = createTelegramNotifier(doorOver(sender), { fallback: recording() });
    const event = triggered(userId, 'trigger-key-1');

    await notifier.notify(event);
    await notifier.notify(event);

    expect(sender.sent).toEqual([{ chatId: CHAT, text: renderWatchEvent(event) }]);
    const rows = await deliveriesOf(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'sent', attempts: 1, dedupKey: 'trigger-key-1', error: null });
  });

  it('throws on a failed delivery, and the next emission retries it on the same row', async () => {
    const userId = await createUser();
    const sender = wire();
    sender.answer = { ok: false, retryable: false, reason: 'telegram: 502 Bad Gateway' };
    const notifier = createTelegramNotifier(doorOver(sender), { fallback: recording() });
    const event = triggered(userId, 'trigger-key-2');

    await expect(notifier.notify(event)).rejects.toThrow('the triggered event was not delivered: telegram: 502 Bad Gateway');
    const [failed] = await deliveriesOf(userId);
    expect(failed).toMatchObject({ status: 'failed', attempts: 1, error: 'telegram: 502 Bad Gateway' });

    sender.answer = { ok: true };
    await notifier.notify(event);

    const rows = await deliveriesOf(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: failed?.id, status: 'sent', attempts: 2, error: null, dedupKey: 'trigger-key-2' });
    expect(sender.sent).toHaveLength(2);
  });

  it('keeps two different events apart, and an unkeyed send a delivery of its own every time', async () => {
    const userId = await createUser();
    const sender = wire();
    const sendToUser = doorOver(sender);
    const notifier = createTelegramNotifier(sendToUser, { fallback: recording() });

    await notifier.notify(triggered(userId, 'trigger-key-3'));
    await notifier.notify(triggered(userId, 'trigger-key-4'));
    await sendToUser(userId, 'a reminder');
    await sendToUser(userId, 'a reminder');

    const rows = await deliveriesOf(userId);
    expect(rows.map((row) => row.dedupKey).sort()).toEqual([null, null, 'trigger-key-3', 'trigger-key-4']);
    expect(sender.sent).toHaveLength(4);
  });

  it('hands an unbound person to the fallback and records no delivery', async () => {
    const userId = await createUser(null);
    const sender = wire();
    const log = recording();
    const notifier = createTelegramNotifier(doorOver(sender), { fallback: log });
    const event = triggered(userId, 'trigger-key-5');

    await notifier.notify(event);

    expect(log.events).toEqual([event]);
    expect(sender.sent).toEqual([]);
    expect(await deliveriesOf(userId)).toEqual([]);
  });
});
