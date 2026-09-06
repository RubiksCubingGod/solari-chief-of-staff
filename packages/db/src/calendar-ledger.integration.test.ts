import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { annotateCalendarItem, recordAutoCancel, recordReminder } from './calendar-ledger.js';
import { createDatabase, type Database } from './client.js';
import { runMigrations } from './migrate.js';
import {
  calendarAutoCancels,
  calendarItems,
  calendarReminders,
  tasks,
  users,
  type CalendarItem,
  type NewCalendarItem,
} from './schema.js';
import { startTestPostgres, type TestPostgres } from './testing/postgres.js';

/**
 * The persisted half of calendar semantics, on the migrated s1 schema: a mark
 * on an entry survives a round trip and obeys the rank rule, and the two
 * idempotence keys - one reminder per (entry, day), one auto-cancel per
 * (entry, renewal) - are unique in the database itself, not only in the code
 * that happens to write them.
 */

let postgres: TestPostgres;
let database: Database;
let userId: string;

beforeAll(async () => {
  postgres = await startTestPostgres();
  await runMigrations(postgres.connectionString);
  database = createDatabase(postgres.connectionString);
  const [user] = await database.db
    .insert(users)
    .values({ email: `${randomUUID()}@example.test` })
    .returning();
  if (user === undefined) throw new Error('the user insert returned no row');
  userId = user.id;
});

afterAll(async () => {
  await database.close();
  await postgres.stop();
});

async function createItem(overrides: Partial<NewCalendarItem> = {}): Promise<CalendarItem> {
  const [item] = await database.db
    .insert(calendarItems)
    .values({ userId, kind: 'subscription', name: 'Gym', renewOn: '2026-09-12', ...overrides })
    .returning();
  if (item === undefined) throw new Error('the calendar item insert returned no row');
  return item;
}

async function readItem(itemId: string): Promise<CalendarItem> {
  const [item] = await database.db.select().from(calendarItems).where(eq(calendarItems.id, itemId));
  if (item === undefined) throw new Error(`calendar item ${itemId} vanished`);
  return item;
}

async function createTaskId(): Promise<string> {
  const [task] = await database.db
    .insert(tasks)
    .values({ userId, kind: 'cancel', input: { site: 'fakegym' }, mode: 'playbook' })
    .returning();
  if (task === undefined) throw new Error('the task insert returned no row');
  return task.id;
}

/** Postgres's own refusal of a duplicate key, however the driver wraps it. */
async function refusedAsDuplicate(attempt: Promise<unknown>): Promise<void> {
  await expect(attempt).rejects.toSatisfy((error: unknown) => {
    const seen: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      seen.push(current.message);
      current = current.cause;
    }
    return seen.some((message) => message.includes('duplicate key value violates unique constraint'));
  });
}

describe('an entry comes with its reminder settings', () => {
  it('reminds three days ahead, does not auto-cancel, and carries no mark until an engine leaves one', async () => {
    const item = await createItem();

    expect(item).toMatchObject({
      reminderLeadDays: 3,
      autoCancel: false,
      autoCancelLeadDays: 3,
      annotation: null,
      annotationNote: null,
      annotatedAt: null,
    });
  });

  it('keeps the settings a person chose', async () => {
    const item = await createItem({ reminderLeadDays: 10, autoCancel: true, autoCancelLeadDays: 1 });

    expect(await readItem(item.id)).toMatchObject({
      reminderLeadDays: 10,
      autoCancel: true,
      autoCancelLeadDays: 1,
    });
  });
});

describe('annotating an entry', () => {
  const now = new Date('2026-09-10T08:00:00Z');

  it('marks an unmarked entry, with the note and the time', async () => {
    const item = await createItem();

    const outcome = await annotateCalendarItem(database.db, item.id, 'late', {
      note: 'reminded a day late',
      now,
    });

    expect(outcome).toMatchObject({ applied: true });
    expect(await readItem(item.id)).toMatchObject({
      annotation: 'late',
      annotationNote: 'reminded a day late',
      annotatedAt: now,
    });
  });

  it('lets each stronger mark replace the one before it', async () => {
    const item = await createItem();

    for (const annotation of ['late', 'needs_attention', 'declined', 'handled'] as const) {
      expect(await annotateCalendarItem(database.db, item.id, annotation)).toMatchObject({
        applied: true,
        item: { annotation },
      });
    }

    expect((await readItem(item.id)).annotation).toBe('handled');
  });

  it('refuses a weaker mark over a stronger one and leaves the row as it was', async () => {
    const item = await createItem();
    await annotateCalendarItem(database.db, item.id, 'declined', { note: 'said no on Telegram', now });

    const outcome = await annotateCalendarItem(database.db, item.id, 'late', {
      note: 'this must not land',
      now: new Date('2026-09-11T08:00:00Z'),
    });

    expect(outcome).toEqual({ applied: false, reason: 'outranked', current: 'declined' });
    expect(await readItem(item.id)).toMatchObject({
      annotation: 'declined',
      annotationNote: 'said no on Telegram',
      annotatedAt: now,
    });
  });

  it('writes the same mark again, so a second late reminder updates the note', async () => {
    const item = await createItem();
    await annotateCalendarItem(database.db, item.id, 'late', { note: 'first' });

    const outcome = await annotateCalendarItem(database.db, item.id, 'late', { note: 'second' });

    expect(outcome).toMatchObject({ applied: true });
    expect((await readItem(item.id)).annotationNote).toBe('second');
  });

  it('says so when there is no such entry', async () => {
    expect(await annotateCalendarItem(database.db, randomUUID(), 'handled')).toEqual({
      applied: false,
      reason: 'not_found',
    });
  });
});

describe('the reminder key: one per entry and day', () => {
  it('records the first reminder for a day and hands the same row back for the second', async () => {
    const item = await createItem();

    const first = await recordReminder(database.db, item.id, '2026-09-09');
    const second = await recordReminder(database.db, item.id, '2026-09-09');

    expect(first).toMatchObject({
      recorded: true,
      reminder: { itemId: item.id, dueOn: '2026-09-09', state: 'pending', attempts: 0 },
    });
    expect(second).toEqual({ recorded: false, reminder: first.reminder });
    expect(
      await database.db.select().from(calendarReminders).where(eq(calendarReminders.itemId, item.id)),
    ).toHaveLength(1);
  });

  it('is a different key on a different day, and for a different entry on the same day', async () => {
    const item = await createItem();
    const other = await createItem({ name: 'Other gym' });
    await recordReminder(database.db, item.id, '2026-09-09');

    expect((await recordReminder(database.db, item.id, '2026-09-10')).recorded).toBe(true);
    expect((await recordReminder(database.db, other.id, '2026-09-09')).recorded).toBe(true);
  });

  it('is enforced by the database, not by the ledger being polite', async () => {
    const item = await createItem();
    await recordReminder(database.db, item.id, '2026-09-09');

    await refusedAsDuplicate(
      database.db.insert(calendarReminders).values({ itemId: item.id, dueOn: '2026-09-09' }),
    );
  });
});

describe('the auto-cancel key: one per entry and renewal', () => {
  it('records the first decision for a renewal and hands it back for the second', async () => {
    const item = await createItem({ autoCancel: true });
    const taskId = await createTaskId();

    const first = await recordAutoCancel(database.db, item.id, '2026-09-12', { state: 'enqueued', taskId });
    const second = await recordAutoCancel(database.db, item.id, '2026-09-12', { state: 'enqueued' });

    expect(first).toMatchObject({
      recorded: true,
      autoCancel: { itemId: item.id, renewOn: '2026-09-12', state: 'enqueued', taskId },
    });
    expect(second).toEqual({ recorded: false, autoCancel: first.autoCancel });
    expect(
      await database.db
        .select()
        .from(calendarAutoCancels)
        .where(eq(calendarAutoCancels.itemId, item.id)),
    ).toHaveLength(1);
  });

  it('records an entry nobody can act on without a task', async () => {
    const item = await createItem({ autoCancel: true });

    const outcome = await recordAutoCancel(database.db, item.id, '2026-09-12', { state: 'unlinked' });

    expect(outcome).toMatchObject({
      recorded: true,
      autoCancel: { state: 'unlinked', taskId: null },
    });
  });

  it('is a different key for the next renewal', async () => {
    const item = await createItem({ autoCancel: true });
    await recordAutoCancel(database.db, item.id, '2026-09-12', { state: 'unlinked' });

    expect(
      (await recordAutoCancel(database.db, item.id, '2026-10-12', { state: 'unlinked' })).recorded,
    ).toBe(true);
  });

  it('is enforced by the database', async () => {
    const item = await createItem({ autoCancel: true });
    await recordAutoCancel(database.db, item.id, '2026-09-12', { state: 'unlinked' });

    await refusedAsDuplicate(
      database.db
        .insert(calendarAutoCancels)
        .values({ itemId: item.id, renewOn: '2026-09-12', state: 'unlinked' }),
    );
  });

  it('keeps its record when the task it enqueued is deleted', async () => {
    const item = await createItem({ autoCancel: true });
    const taskId = await createTaskId();
    await recordAutoCancel(database.db, item.id, '2026-09-12', { state: 'enqueued', taskId });

    await database.db.delete(tasks).where(eq(tasks.id, taskId));

    const [row] = await database.db
      .select()
      .from(calendarAutoCancels)
      .where(eq(calendarAutoCancels.itemId, item.id));
    expect(row).toMatchObject({ renewOn: '2026-09-12', taskId: null });
  });
});

describe('deleting an entry', () => {
  it('takes its reminders and auto-cancel records with it', async () => {
    const item = await createItem({ autoCancel: true });
    await recordReminder(database.db, item.id, '2026-09-09');
    await recordAutoCancel(database.db, item.id, '2026-09-12', { state: 'unlinked' });

    await database.db.delete(calendarItems).where(eq(calendarItems.id, item.id));

    expect(
      await database.db.select().from(calendarReminders).where(eq(calendarReminders.itemId, item.id)),
    ).toEqual([]);
    expect(
      await database.db
        .select()
        .from(calendarAutoCancels)
        .where(eq(calendarAutoCancels.itemId, item.id)),
    ).toEqual([]);
  });
});
