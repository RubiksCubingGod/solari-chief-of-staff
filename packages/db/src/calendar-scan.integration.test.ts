import { randomUUID } from 'node:crypto';

import { asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  CALENDAR_SCAN_CRON,
  CALENDAR_SCAN_QUEUE,
  REMINDER_SEND_ATTEMPTS,
  registerCalendarScan,
  runCalendarScan,
  type ReminderSendOutcome,
  type ReminderSender,
} from './calendar-scan.js';
import { createDatabase, type Database } from './client.js';
import { createJobHarness, runWorker, type JobHarness } from './jobs.js';
import { runMigrations } from './migrate.js';
import { calendarItems, calendarReminders, users, type NewCalendarItem } from './schema.js';
import { startTestPostgres, type TestPostgres } from './testing/postgres.js';

/**
 * The reminder scan (reminder-path spec) on a migrated database, with the
 * send port scripted.
 *
 * What is proved is the record-before-dispatch discipline and everything it
 * buys: a reminder for one entry and one day goes out once whatever happens
 * around it - a second scan, two scans at once, a worker that died between
 * writing the row and sending - and every way a send can end is written down
 * where the dashboard can read it. The words on the wire and the delivery row
 * are the composed proof's business (`tests/calendar-reminders`); here the
 * port answers whatever the test says it does.
 */

let postgres: TestPostgres;
let database: Database;
const started: JobHarness[] = [];

beforeAll(async () => {
  postgres = await startTestPostgres();
  await runMigrations(postgres.connectionString);
  database = createDatabase(postgres.connectionString);
});

afterEach(async () => {
  for (const harness of started.splice(0)) await harness.stop();
  // Every entry, reminder and mark hangs off a user, so this is the whole reset.
  await database.db.delete(users);
});

afterAll(async () => {
  await database.close();
  await postgres.stop();
});

interface PortCall {
  readonly userId: string;
  readonly text: string;
}

interface ScriptedPort {
  readonly send: ReminderSender;
  /** Every time the port was asked, oldest first. A crash is not a call: nothing was asked. */
  readonly calls: PortCall[];
  /** What the next sends answer, oldest first; past the end, every send is sent. */
  script(...outcomes: readonly (ReminderSendOutcome | Error)[]): void;
}

function scriptedPort(): ScriptedPort {
  const calls: PortCall[] = [];
  const queue: (ReminderSendOutcome | Error)[] = [];
  return {
    calls,
    script: (...outcomes) => {
      queue.push(...outcomes);
    },
    send: (userId, text) => {
      const next = queue.shift();
      if (next instanceof Error) return Promise.reject(next);
      calls.push({ userId, text });
      return Promise.resolve(next ?? { kind: 'sent' });
    },
  };
}

/** Noon on the lead day of a renewal on the 12th with the default three-day lead. */
const LEAD_DAY_NOON = '2026-09-09T12:00:00Z';
const at = (iso: string) => () => new Date(iso);

async function insertUser(tz = 'UTC'): Promise<string> {
  const [user] = await database.db
    .insert(users)
    .values({ email: `${randomUUID()}@example.test`, tz })
    .returning();
  if (user === undefined) throw new Error('the user insert returned no row');
  return user.id;
}

async function insertItem(
  userId: string,
  overrides: Partial<NewCalendarItem> = {},
): Promise<string> {
  const [item] = await database.db
    .insert(calendarItems)
    .values({
      userId,
      kind: 'subscription',
      name: 'Gym',
      amountCents: 4500,
      renewOn: '2026-09-12',
      ...overrides,
    })
    .returning();
  if (item === undefined) throw new Error('the item insert returned no row');
  return item.id;
}

async function remindersOf(itemId: string) {
  return database.db
    .select()
    .from(calendarReminders)
    .where(eq(calendarReminders.itemId, itemId))
    .orderBy(asc(calendarReminders.dueOn));
}

async function markOn(itemId: string) {
  const [row] = await database.db
    .select({ annotation: calendarItems.annotation, note: calendarItems.annotationNote })
    .from(calendarItems)
    .where(eq(calendarItems.id, itemId));
  return row;
}

describe('runCalendarScan', () => {
  it('sends one reminder on the lead day and records the delivery against the entry', async () => {
    const userId = await insertUser();
    const itemId = await insertItem(userId);
    const port = scriptedPort();

    const report = await runCalendarScan({
      db: database.db,
      send: port.send,
      now: at(LEAD_DAY_NOON),
    });

    expect(port.calls).toEqual([
      { userId, text: 'Reminder: Gym renews on 2026-09-12 (in 3 days). Amount: 45.00.' },
    ]);
    expect(report).toEqual({ due: 1, delivered: 1, late: 0, failed: 0, skipped: 0 });
    const rows = await remindersOf(itemId);
    expect(rows).toMatchObject([
      { dueOn: '2026-09-09', state: 'delivered', attempts: 1, error: null },
    ]);
    expect(rows[0]?.settledAt).toBeInstanceOf(Date);
    // Delivered on time is not a mark; the entry has nothing to explain.
    expect(await markOn(itemId)).toEqual({ annotation: null, note: null });
  });

  it('reminds about a deadline the same way, by its cancel-by and its own lead', async () => {
    const userId = await insertUser();
    const itemId = await insertItem(userId, {
      kind: 'deadline',
      name: 'Taxes',
      amountCents: null,
      renewOn: null,
      cancelBy: '2026-10-01',
      reminderLeadDays: 7,
    });
    const port = scriptedPort();

    await runCalendarScan({ db: database.db, send: port.send, now: at('2026-09-24T12:00:00Z') });

    expect(port.calls).toEqual([
      { userId, text: 'Reminder: Taxes is due by 2026-10-01 (in 7 days).' },
    ]);
    expect(await remindersOf(itemId)).toMatchObject([{ dueOn: '2026-09-24', state: 'delivered' }]);
  });

  it('sends nothing before the lead day, and nothing for an entry that is done or handled', async () => {
    const userId = await insertUser();
    const early = await insertItem(userId, { renewOn: '2026-09-20' });
    const done = await insertItem(userId, { status: 'done' });
    const handled = await insertItem(userId, { annotation: 'handled' });
    const port = scriptedPort();

    const report = await runCalendarScan({
      db: database.db,
      send: port.send,
      now: at(LEAD_DAY_NOON),
    });

    expect(port.calls).toEqual([]);
    expect(report).toEqual({ due: 0, delivered: 0, late: 0, failed: 0, skipped: 0 });
    for (const itemId of [early, done, handled]) expect(await remindersOf(itemId)).toEqual([]);
  });

  it('sends nothing more on a second scan the same day', async () => {
    const userId = await insertUser();
    const itemId = await insertItem(userId);
    const port = scriptedPort();
    const scan = () =>
      runCalendarScan({ db: database.db, send: port.send, now: at(LEAD_DAY_NOON) });

    await scan();
    const again = await scan();

    expect(port.calls).toHaveLength(1);
    // Still owed today, already delivered: counted, not sent.
    expect(again).toEqual({ due: 1, delivered: 0, late: 0, failed: 0, skipped: 0 });
    expect(await remindersOf(itemId)).toHaveLength(1);
  });

  it('sends once when scans overlap', async () => {
    const userId = await insertUser();
    await insertItem(userId);
    const port = scriptedPort();
    const scan = () =>
      runCalendarScan({ db: database.db, send: port.send, now: at(LEAD_DAY_NOON) });

    // Cron overlap and a second worker look the same from here: scans that
    // each find the reminder owed and none of which sees another's send.
    await Promise.all([scan(), scan(), scan()]);

    expect(port.calls).toHaveLength(1);
  });

  it('leaves a pending row when it dies between recording and sending, and the next scan sends once', async () => {
    const userId = await insertUser();
    const itemId = await insertItem(userId);
    const port = scriptedPort();
    port.script(new Error('the worker died'));
    const scan = () =>
      runCalendarScan({ db: database.db, send: port.send, now: at(LEAD_DAY_NOON) });

    // A crash is a crash: the scan does not catch it, because the job harness
    // is what retries it, and a job that swallowed its own failure would not be.
    await expect(scan()).rejects.toThrow('the worker died');

    expect(port.calls).toEqual([]);
    // The row says a message was owed and an attempt began; nothing says it was sent.
    expect(await remindersOf(itemId)).toMatchObject([
      { dueOn: '2026-09-09', state: 'pending', attempts: 1, settledAt: null },
    ]);

    await scan();

    expect(port.calls).toHaveLength(1);
    expect(await remindersOf(itemId)).toMatchObject([{ state: 'delivered', attempts: 2 }]);
  });

  it('records a skip for a person with no chat bound, and does not ask again', async () => {
    const userId = await insertUser();
    const itemId = await insertItem(userId);
    const port = scriptedPort();
    port.script({ kind: 'unbound' });
    const scan = () =>
      runCalendarScan({ db: database.db, send: port.send, now: at(LEAD_DAY_NOON) });

    const first = await scan();
    const second = await scan();

    expect(first).toEqual({ due: 1, delivered: 0, late: 0, failed: 0, skipped: 1 });
    // Nothing was attempted, so there is nothing to retry: the skip is the
    // record, visible on the entry, and a person who binds a chat tomorrow
    // gets tomorrow's reminders.
    expect(second).toEqual({ due: 1, delivered: 0, late: 0, failed: 0, skipped: 0 });
    expect(port.calls).toHaveLength(1);
    expect(await remindersOf(itemId)).toMatchObject([
      { state: 'skipped_unbound', attempts: 1, error: null },
    ]);
  });

  it('retries a failed send on the next scan, and gives up after the third', async () => {
    const userId = await insertUser();
    const itemId = await insertItem(userId);
    const port = scriptedPort();
    port.script(
      { kind: 'failed', error: 'Telegram: 502 Bad Gateway' },
      { kind: 'failed', error: 'Telegram: 502 Bad Gateway' },
      { kind: 'failed', error: 'Telegram: 429 Too Many Requests' },
    );
    const scan = () =>
      runCalendarScan({ db: database.db, send: port.send, now: at(LEAD_DAY_NOON) });

    expect(REMINDER_SEND_ATTEMPTS).toBe(3);
    const first = await scan();
    expect(first).toEqual({ due: 1, delivered: 0, late: 0, failed: 1, skipped: 0 });
    expect(await remindersOf(itemId)).toMatchObject([
      { state: 'failed', attempts: 1, error: 'Telegram: 502 Bad Gateway' },
    ]);

    await scan();
    const third = await scan();
    expect(third.failed).toBe(1);
    expect(await remindersOf(itemId)).toMatchObject([
      { state: 'failed', attempts: 3, error: 'Telegram: 429 Too Many Requests' },
    ]);

    const fourth = await scan();

    expect(port.calls).toHaveLength(3);
    expect(fourth).toEqual({ due: 1, delivered: 0, late: 0, failed: 0, skipped: 0 });
    expect(await remindersOf(itemId)).toMatchObject([{ state: 'failed', attempts: 3 }]);
  });

  it('settles a retry that gets through as delivered, with nothing left to explain', async () => {
    const userId = await insertUser();
    const itemId = await insertItem(userId);
    const port = scriptedPort();
    port.script({ kind: 'failed', error: 'Telegram: 502 Bad Gateway' }, { kind: 'sent' });
    const scan = () =>
      runCalendarScan({ db: database.db, send: port.send, now: at(LEAD_DAY_NOON) });

    await scan();
    await scan();

    expect(await remindersOf(itemId)).toMatchObject([
      { state: 'delivered', attempts: 2, error: null },
    ]);
  });

  it('after a missed window, sends the reminder late, says so, and marks the entry', async () => {
    const userId = await insertUser();
    const itemId = await insertItem(userId);
    const port = scriptedPort();

    // The worker was down on the 9th and the 10th.
    const report = await runCalendarScan({
      db: database.db,
      send: port.send,
      now: at('2026-09-11T12:00:00Z'),
    });

    expect(port.calls).toEqual([
      { userId, text: 'Late reminder: Gym renews on 2026-09-12 (tomorrow). Amount: 45.00.' },
    ]);
    expect(report).toEqual({ due: 1, delivered: 0, late: 1, failed: 0, skipped: 0 });
    // Keyed by the day it was first owed, so the late send is the same
    // reminder and not a second one.
    expect(await remindersOf(itemId)).toMatchObject([{ dueOn: '2026-09-09', state: 'late' }]);
    expect(await markOn(itemId)).toEqual({
      annotation: 'late',
      note: 'The reminder for 2026-09-09 went out on 2026-09-11.',
    });

    // The day after, it is still the same reminder: nothing more goes out.
    await runCalendarScan({ db: database.db, send: port.send, now: at('2026-09-12T12:00:00Z') });
    expect(port.calls).toHaveLength(1);
  });

  it('never lets a late mark erase a stronger one', async () => {
    const userId = await insertUser();
    const itemId = await insertItem(userId, {
      annotation: 'declined',
      annotationNote: 'Said no to cancelling',
    });
    const port = scriptedPort();

    await runCalendarScan({ db: database.db, send: port.send, now: at('2026-09-11T12:00:00Z') });

    // Declined the cancellation, still reminded, still declined.
    expect(port.calls).toHaveLength(1);
    expect(await remindersOf(itemId)).toMatchObject([{ state: 'late' }]);
    expect(await markOn(itemId)).toEqual({
      annotation: 'declined',
      note: 'Said no to cancelling',
    });
  });

  it('reads today off each person’s own clock, and waits for their morning', async () => {
    const auckland = await insertUser('Pacific/Auckland');
    const london = await insertUser('Europe/London');
    await insertItem(auckland);
    await insertItem(london);
    const port = scriptedPort();
    const scan = (iso: string) =>
      runCalendarScan({ db: database.db, send: port.send, now: at(iso) });

    // 21:30 UTC on the 8th is 09:30 on the 9th in Auckland and 22:30 on the
    // 8th in London: the lead day for one of them.
    expect(await scan('2026-09-08T21:30:00Z')).toMatchObject({ due: 1, delivered: 1 });
    expect(port.calls.map((call) => call.userId)).toEqual([auckland]);
    expect(port.calls[0]?.text).toContain('in 3 days');

    // 05:00 UTC on the 9th is 06:00 in London: the right day, too early to
    // buzz a phone. Not owed yet, so not counted; the one owed is Auckland's,
    // already delivered.
    expect(await scan('2026-09-09T05:00:00Z')).toMatchObject({ due: 1, delivered: 0 });
    expect(port.calls).toHaveLength(1);

    // 08:00 UTC is 09:00 in London.
    expect(await scan('2026-09-09T08:00:00Z')).toMatchObject({ due: 2, delivered: 1 });
    expect(port.calls.map((call) => call.userId)).toEqual([auckland, london]);
    expect(port.calls[1]?.text).toBe(
      'Reminder: Gym renews on 2026-09-12 (in 3 days). Amount: 45.00.',
    );
  });
});

describe('registerCalendarScan', () => {
  it('scans once at startup, then on an hourly cron, and a queued scan is as idempotent as a direct one', async () => {
    const userId = await insertUser();
    const itemId = await insertItem(userId);
    const port = scriptedPort();
    const harness = createJobHarness({
      connectionString: postgres.connectionString,
      schema: `pgboss_${randomUUID().slice(0, 8)}`,
      pollingIntervalSeconds: 0.5,
    });
    started.push(harness);

    await runWorker(harness, [
      registerCalendarScan({ db: database.db, send: port.send, now: at(LEAD_DAY_NOON) }),
    ]);

    await vi.waitFor(() => expect(port.calls).toHaveLength(1), { timeout: 10_000 });
    expect(port.calls[0]?.userId).toBe(userId);
    expect(port.calls[0]?.text).toContain('Gym renews');
    expect(await harness.schedules(CALENDAR_SCAN_QUEUE)).toEqual([
      { queue: CALENDAR_SCAN_QUEUE, key: '', cron: CALENDAR_SCAN_CRON, payload: {} },
    ]);
    expect(CALENDAR_SCAN_CRON).toBe('0 * * * *');

    const jobId = await harness.enqueue(CALENDAR_SCAN_QUEUE, {});
    await vi.waitFor(
      async () =>
        expect((await harness.inspect(CALENDAR_SCAN_QUEUE, jobId))?.state).toBe('completed'),
      { timeout: 10_000 },
    );

    expect(port.calls).toHaveLength(1);
    expect(await remindersOf(itemId)).toMatchObject([{ state: 'delivered', attempts: 1 }]);
  });
});
