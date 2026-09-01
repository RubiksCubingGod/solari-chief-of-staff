import { randomUUID } from 'node:crypto';

import { runMigrations, tasks, users, watches, calendarItems } from '@chief-of-staff/db';
import { startTestPostgres, type TestPostgres } from '@chief-of-staff/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

let postgres: TestPostgres;
let app: FastifyInstance;
let ownerId: string;
let strangerId: string;

async function createUser(telegramChatId: string): Promise<string> {
  const [created] = await app.db.insert(users).values({ telegramChatId }).returning();
  if (created === undefined) throw new Error('the fixture user was not created');
  return created.id;
}

beforeAll(async () => {
  postgres = await startTestPostgres();
  await runMigrations(postgres.connectionString);
  app = createApp({ DATABASE_URL: postgres.connectionString, LOG_LEVEL: 'silent' });
  await app.ready();
  ownerId = await createUser('owner');
  strangerId = await createUser('stranger');
});

afterAll(async () => {
  // The database is dropped even if the server never came up, so a failed boot
  // does not leave a stray test database behind on a shared server.
  try {
    await app.close();
  } finally {
    await postgres.stop();
  }
});

beforeEach(async () => {
  await app.db.delete(watches);
  await app.db.delete(calendarItems);
  await app.db.delete(tasks);
});

/** The headers of a request from the user every test acts as. */
function asOwner(): Record<string, string> {
  return { 'x-user-id': ownerId };
}

const A_WATCH = {
  kind: 'price',
  url: 'https://shop.test/item/1',
  schedule: '0 * * * *',
  condition: { drops_below: 4999 },
} as const;

function paths(body: string): string[] {
  const envelope = JSON.parse(body) as { error: { details?: { path: string }[] } };
  return (envelope.error.details ?? []).map((detail) => detail.path).sort();
}

function code(body: string): string {
  return (JSON.parse(body) as { error: { code: string } }).error.code;
}

describe('POST /watches', () => {
  it('persists a watch and reads it back through the list', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/watches',
      headers: asOwner(),
      payload: A_WATCH,
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      userId: ownerId,
      kind: 'price',
      url: A_WATCH.url,
      schedule: A_WATCH.schedule,
      condition: { drops_below: 4999 },
      extractor: {},
      tierPolicy: 'auto',
      status: 'active',
      lastValue: null,
      lastCheckedAt: null,
      consecutiveFailures: 0,
    });

    const listed = await app.inject({ method: 'GET', url: '/watches', headers: asOwner() });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([created.json()]);
  });

  it('refuses every bad field at once and stores nothing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/watches',
      headers: asOwner(),
      payload: {
        kind: 'weather',
        url: 'shop.test/item/1',
        schedule: 'every other friday',
        condition: { drops_below: 4999 },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(code(response.body)).toBe('validation_failed');
    expect(paths(response.body)).toEqual(['/kind', '/schedule', '/url']);
    await expect(app.db.select().from(watches)).resolves.toEqual([]);
  });

  it('refuses a field it does not know rather than silently dropping it', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/watches',
      headers: asOwner(),
      payload: { ...A_WATCH, notifyBy: 'carrier pigeon' },
    });

    expect(response.statusCode).toBe(400);
    expect(code(response.body)).toBe('validation_failed');
    await expect(app.db.select().from(watches)).resolves.toEqual([]);
  });

  it('refuses a caller that does not exist and one that is not an id at all', async () => {
    const unknown = await app.inject({
      method: 'POST',
      url: '/watches',
      headers: { 'x-user-id': randomUUID() },
      payload: A_WATCH,
    });
    expect(unknown.statusCode).toBe(404);
    expect(code(unknown.body)).toBe('not_found');

    const malformed = await app.inject({
      method: 'GET',
      url: '/watches',
      headers: { 'x-user-id': 'me' },
    });
    expect(malformed.statusCode).toBe(400);
    expect(code(malformed.body)).toBe('validation_failed');

    await expect(app.db.select().from(watches)).resolves.toEqual([]);
  });
});

describe('PATCH /watches/:id', () => {
  async function createWatchFor(userId: string): Promise<string> {
    const [created] = await app.db
      .insert(watches)
      .values({ ...A_WATCH, userId, extractor: {} })
      .returning();
    if (created === undefined) throw new Error('the fixture watch was not created');
    return created.id;
  }

  it('pauses and resumes a watch the caller owns', async () => {
    const id = await createWatchFor(ownerId);

    const paused = await app.inject({
      method: 'PATCH',
      url: `/watches/${id}`,
      headers: asOwner(),
      payload: { status: 'paused' },
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({ id, status: 'paused' });

    const resumed = await app.inject({
      method: 'PATCH',
      url: `/watches/${id}`,
      headers: asOwner(),
      payload: { status: 'active' },
    });
    expect(resumed.json()).toMatchObject({ id, status: 'active' });
  });

  it('leaves another user’s watch untouched', async () => {
    const id = await createWatchFor(strangerId);

    const response = await app.inject({
      method: 'PATCH',
      url: `/watches/${id}`,
      headers: asOwner(),
      payload: { status: 'paused' },
    });

    expect(response.statusCode).toBe(404);
    expect(code(response.body)).toBe('not_found');
    const [row] = await app.db.select().from(watches);
    expect(row?.status).toBe('active');
  });

  it('refuses a status outside the vocabulary and an id that is not a uuid', async () => {
    const id = await createWatchFor(ownerId);

    const badStatus = await app.inject({
      method: 'PATCH',
      url: `/watches/${id}`,
      headers: asOwner(),
      payload: { status: 'snoozed' },
    });
    expect(badStatus.statusCode).toBe(400);
    expect(paths(badStatus.body)).toEqual(['/status']);

    const badId = await app.inject({
      method: 'PATCH',
      url: '/watches/not-a-uuid',
      headers: asOwner(),
      payload: { status: 'paused' },
    });
    expect(badId.statusCode).toBe(400);

    const [row] = await app.db.select().from(watches);
    expect(row?.status).toBe('active');
  });
});

describe('calendar items', () => {
  const A_SUBSCRIPTION = {
    kind: 'subscription',
    name: 'Planet Fitness',
    amountCents: 2499,
    renewOn: '2026-10-12',
  };

  it('persists a subscription and a deadline, and lists them by name', async () => {
    const subscription = await app.inject({
      method: 'POST',
      url: '/calendar-items',
      headers: asOwner(),
      payload: A_SUBSCRIPTION,
    });
    expect(subscription.statusCode).toBe(201);
    expect(subscription.json()).toMatchObject({
      userId: ownerId,
      kind: 'subscription',
      name: 'Planet Fitness',
      amountCents: 2499,
      renewOn: '2026-10-12',
      cancelBy: null,
      action: null,
      status: 'active',
    });

    const deadline = await app.inject({
      method: 'POST',
      url: '/calendar-items',
      headers: asOwner(),
      payload: { kind: 'deadline', name: 'Amend the return', cancelBy: '2026-10-15' },
    });
    expect(deadline.statusCode).toBe(201);

    const listed = await app.inject({
      method: 'GET',
      url: '/calendar-items',
      headers: asOwner(),
    });
    expect(listed.json()).toEqual([deadline.json(), subscription.json()]);
  });

  it('refuses a subscription with no renewal date and stores nothing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/calendar-items',
      headers: asOwner(),
      payload: { kind: 'subscription', name: 'Planet Fitness', amountCents: 2499 },
    });

    expect(response.statusCode).toBe(400);
    expect(code(response.body)).toBe('validation_failed');
    // The missing field is a condition on the whole object, not on one of its
    // properties, so Ajv reports it at the root pointer.
    expect(paths(response.body)).toContain('');
    await expect(app.db.select().from(calendarItems)).resolves.toEqual([]);
  });

  it('refuses a fractional amount, a negative one, and a date that is not one', async () => {
    for (const payload of [
      { ...A_SUBSCRIPTION, amountCents: 24.99 },
      { ...A_SUBSCRIPTION, amountCents: -1 },
      { ...A_SUBSCRIPTION, renewOn: '2026-13-40' },
      { ...A_SUBSCRIPTION, name: '' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/calendar-items',
        headers: asOwner(),
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(code(response.body)).toBe('validation_failed');
    }

    await expect(app.db.select().from(calendarItems)).resolves.toEqual([]);
  });
});

describe('GET /tasks', () => {
  it('returns the caller’s tasks newest first and nobody else’s', async () => {
    const [older] = await app.db
      .insert(tasks)
      .values({
        userId: ownerId,
        kind: 'cancel',
        mode: 'playbook',
        input: { what: 'gym' },
        createdAt: new Date('2026-08-01T00:00:00Z'),
      })
      .returning();
    const [newer] = await app.db
      .insert(tasks)
      .values({
        userId: ownerId,
        kind: 'book_slot',
        mode: 'agentic',
        input: { what: 'haircut' },
        createdAt: new Date('2026-08-02T00:00:00Z'),
      })
      .returning();
    await app.db
      .insert(tasks)
      .values({ userId: strangerId, kind: 'custom', mode: 'agentic', input: {} });

    const response = await app.inject({ method: 'GET', url: '/tasks', headers: asOwner() });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ id: string }[]>().map((task) => task.id)).toEqual([
      newer?.id,
      older?.id,
    ]);
  });
});
