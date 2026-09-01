import { randomUUID } from 'node:crypto';

import {
  observations,
  runMigrations,
  tasks,
  users,
  watches,
  calendarItems,
} from '@chief-of-staff/db';
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

async function createWatchFor(userId: string): Promise<string> {
  const [created] = await app.db
    .insert(watches)
    .values({ ...A_WATCH, userId, extractor: {} })
    .returning();
  if (created === undefined) throw new Error('the fixture watch was not created');
  return created.id;
}

/**
 * A refusal with the row id taken out of it, so the answer to a stranger's row
 * and the answer to a row that never existed can be compared character for
 * character without pinning the wording either of them uses.
 */
function withoutId(body: string, id: string): string {
  return body.replaceAll(id, '{id}');
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

describe('POST /tasks', () => {
  it('queues a task the chat loop asked for and reads it back through the list', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: asOwner(),
      payload: { kind: 'cancel', input: { what: 'gym', connection: 'fakegym' } },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      userId: ownerId,
      kind: 'cancel',
      input: { what: 'gym', connection: 'fakegym' },
      // Queued and nothing more: this sprint has no engine, and the row is the
      // whole of what "I have queued that" is allowed to mean.
      status: 'queued',
      // ARCHITECTURE 3.2 tries a playbook before an agentic run, so a caller
      // that does not say gets the cheaper of the two rather than the general
      // one.
      mode: 'playbook',
      playbookId: null,
      solariSessionId: null,
      recordingUrl: null,
      result: null,
      finishedAt: null,
    });

    const listed = await app.inject({ method: 'GET', url: '/tasks', headers: asOwner() });
    expect(listed.json()).toEqual([created.json()]);
  });

  it('takes an explicit mode when the caller has one', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: asOwner(),
      payload: { kind: 'custom', input: {}, mode: 'agentic' },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ mode: 'agentic' });
  });

  it('refuses every bad field at once and stores nothing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: asOwner(),
      payload: { kind: 'evict', input: 'the gym', mode: 'vibes' },
    });

    expect(response.statusCode).toBe(400);
    expect(code(response.body)).toBe('validation_failed');
    expect(paths(response.body)).toEqual(['/input', '/kind', '/mode']);
    await expect(app.db.select().from(tasks)).resolves.toEqual([]);
  });

  it('refuses a status the caller tried to set rather than silently dropping it', async () => {
    // The engine owns every status after `queued`. A body that could name one
    // would let chat mark its own work done.
    const response = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: asOwner(),
      payload: { kind: 'cancel', input: {}, status: 'succeeded' },
    });

    expect(response.statusCode).toBe(400);
    expect(code(response.body)).toBe('validation_failed');
    await expect(app.db.select().from(tasks)).resolves.toEqual([]);
  });

  it('refuses an unknown caller before it writes a row', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { 'x-user-id': randomUUID() },
      payload: { kind: 'cancel', input: {} },
    });

    expect(response.statusCode).toBe(404);
    // The refusal has to be the caller check rather than a missing route, which
    // answers 404 too — naming the header is what tells the two apart.
    expect(response.json<{ error: { message: string } }>().error.message).toContain('x-user-id');
    await expect(app.db.select().from(tasks)).resolves.toEqual([]);
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

describe('GET /watches/:id/observations', () => {
  // Five checks a day apart. The window every bounded test asks for opens on
  // the second and closes on the fourth, so one observation sits on each edge
  // and one sits outside each edge.
  const CHECKED_AT = [
    '2026-08-01T00:00:00.000Z',
    '2026-08-02T00:00:00.000Z',
    '2026-08-03T00:00:00.000Z',
    '2026-08-04T00:00:00.000Z',
    '2026-08-05T00:00:00.000Z',
  ] as const;

  async function seedSeries(watchId: string): Promise<void> {
    await app.db.insert(observations).values(
      CHECKED_AT.map((at, index) => ({
        watchId,
        checkedAt: new Date(at),
        tierUsed: 'http' as const,
        value: { cents: 4900 + index },
        triggered: index === CHECKED_AT.length - 1,
      })),
    );
  }

  function series(body: string): string[] {
    return (JSON.parse(body) as { checkedAt: string }[]).map((row) => row.checkedAt);
  }

  it('returns the whole series oldest first, with everything a sparkline draws', async () => {
    const id = await createWatchFor(ownerId);
    await seedSeries(id);

    const response = await app.inject({
      method: 'GET',
      url: `/watches/${id}/observations`,
      headers: asOwner(),
    });

    expect(response.statusCode).toBe(200);
    expect(series(response.body)).toEqual([...CHECKED_AT]);
    // The row carries the value, the tier and the trigger flag, so the page
    // draws the point, the marker and the failure state without asking again.
    expect(response.json<Record<string, unknown>[]>()[0]).toMatchObject({
      watchId: id,
      checkedAt: CHECKED_AT[0],
      tierUsed: 'http',
      value: { cents: 4900 },
      triggered: false,
      error: null,
    });
  });

  it('returns only the observations inside the half-open window', async () => {
    const id = await createWatchFor(ownerId);
    await seedSeries(id);

    const response = await app.inject({
      method: 'GET',
      url: `/watches/${id}/observations?from=${CHECKED_AT[1]}&to=${CHECKED_AT[3]}`,
      headers: asOwner(),
    });

    expect(response.statusCode).toBe(200);
    // `from` is inclusive and `to` is exclusive, so the observation on the
    // opening edge is in the window and the one on the closing edge is not.
    expect(series(response.body)).toEqual([CHECKED_AT[1], CHECKED_AT[2]]);
  });

  it('keeps the newest observations when the series is longer than the limit', async () => {
    const id = await createWatchFor(ownerId);
    await seedSeries(id);

    const response = await app.inject({
      method: 'GET',
      url: `/watches/${id}/observations?limit=2`,
      headers: asOwner(),
    });

    expect(response.statusCode).toBe(200);
    expect(series(response.body)).toEqual([CHECKED_AT[3], CHECKED_AT[4]]);
  });

  it('answers a watch that has never been checked with an empty series', async () => {
    const id = await createWatchFor(ownerId);

    const response = await app.inject({
      method: 'GET',
      url: `/watches/${id}/observations`,
      headers: asOwner(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it('refuses another user’s watch exactly as it refuses one that never existed', async () => {
    const strangerWatchId = await createWatchFor(strangerId);
    await seedSeries(strangerWatchId);
    const unknownId = randomUUID();

    const stranger = await app.inject({
      method: 'GET',
      url: `/watches/${strangerWatchId}/observations`,
      headers: asOwner(),
    });
    const unknown = await app.inject({
      method: 'GET',
      url: `/watches/${unknownId}/observations`,
      headers: asOwner(),
    });

    expect(stranger.statusCode).toBe(404);
    expect(code(stranger.body)).toBe('not_found');
    expect(unknown.statusCode).toBe(404);
    expect(code(unknown.body)).toBe('not_found');
    // Nothing in either answer tells the caller which of the two it hit.
    expect(withoutId(stranger.body, strangerWatchId)).toBe(withoutId(unknown.body, unknownId));
  });

  it('refuses a bound it cannot read, a limit past the ceiling, and an unknown parameter', async () => {
    const id = await createWatchFor(ownerId);

    for (const query of [
      // A calendar day is not an instant: the window would start at a different
      // moment for every caller's zone.
      'from=2026-08-02',
      'from=yesterday',
      'to=2026-08-04T00:00:00',
      'limit=0',
      'limit=abc',
      'limit=-1',
      'limit=501',
      // A misspelled bound is a wider window than the caller asked for, so it
      // is refused rather than dropped.
      'since=2026-08-02T00:00:00.000Z',
    ]) {
      const response = await app.inject({
        method: 'GET',
        url: `/watches/${id}/observations?${query}`,
        headers: asOwner(),
      });
      expect(response.statusCode, query).toBe(400);
      expect(code(response.body), query).toBe('validation_failed');
    }
  });

  it('refuses a window that ends before it starts rather than answering nothing', async () => {
    const id = await createWatchFor(ownerId);
    await seedSeries(id);

    for (const query of [
      `from=${CHECKED_AT[3]}&to=${CHECKED_AT[1]}`,
      `from=${CHECKED_AT[1]}&to=${CHECKED_AT[1]}`,
    ]) {
      const response = await app.inject({
        method: 'GET',
        url: `/watches/${id}/observations?${query}`,
        headers: asOwner(),
      });
      expect(response.statusCode, query).toBe(400);
      expect(code(response.body), query).toBe('bad_request');
    }
  });

  it('refuses a watch id that is not a uuid', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/watches/not-a-uuid/observations',
      headers: asOwner(),
    });

    expect(response.statusCode).toBe(400);
    expect(code(response.body)).toBe('validation_failed');
    expect(paths(response.body)).toEqual(['/id']);
  });
});

describe('GET /tasks/:id', () => {
  async function createTaskFor(userId: string): Promise<string> {
    const [created] = await app.db
      .insert(tasks)
      .values({
        userId,
        kind: 'cancel',
        mode: 'playbook',
        input: { what: 'gym' },
        status: 'succeeded',
        playbookId: 'planet-fitness-cancel',
        result: { cancelled: true },
        createdAt: new Date('2026-08-01T00:00:00Z'),
        finishedAt: new Date('2026-08-01T00:04:00Z'),
      })
      .returning();
    if (created === undefined) throw new Error('the fixture task was not created');
    return created.id;
  }

  it('returns the whole task row the history shell renders', async () => {
    const id = await createTaskFor(ownerId);

    const response = await app.inject({ method: 'GET', url: `/tasks/${id}`, headers: asOwner() });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id,
      userId: ownerId,
      kind: 'cancel',
      mode: 'playbook',
      status: 'succeeded',
      input: { what: 'gym' },
      playbookId: 'planet-fitness-cancel',
      result: { cancelled: true },
      createdAt: '2026-08-01T00:00:00.000Z',
      finishedAt: '2026-08-01T00:04:00.000Z',
      solariSessionId: null,
      recordingUrl: null,
    });
  });

  it('refuses another user’s task exactly as it refuses one that never existed', async () => {
    const strangerTaskId = await createTaskFor(strangerId);
    const unknownId = randomUUID();

    const stranger = await app.inject({
      method: 'GET',
      url: `/tasks/${strangerTaskId}`,
      headers: asOwner(),
    });
    const unknown = await app.inject({
      method: 'GET',
      url: `/tasks/${unknownId}`,
      headers: asOwner(),
    });

    expect(stranger.statusCode).toBe(404);
    expect(code(stranger.body)).toBe('not_found');
    expect(unknown.statusCode).toBe(404);
    expect(code(unknown.body)).toBe('not_found');
    expect(withoutId(stranger.body, strangerTaskId)).toBe(withoutId(unknown.body, unknownId));
  });

  it('refuses a task id that is not a uuid', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/tasks/not-a-uuid',
      headers: asOwner(),
    });

    expect(response.statusCode).toBe(400);
    expect(code(response.body)).toBe('validation_failed');
    expect(paths(response.body)).toEqual(['/id']);
  });
});
