import { randomUUID } from 'node:crypto';

import {
  calendarDayIn,
  isTerminalTaskStatus,
  type AskUserEventPayload,
  type IsoDate,
} from '@chief-of-staff/core';
import {
  TELEGRAM_LIVE_CHAT_VARIABLE,
  TELEGRAM_TOKEN_VARIABLE,
  createBotRuntime,
  createReminderSender,
  createTelegramUserIO,
  liveTelegramSkipReason,
  loadBotConfig,
  type BotRuntime,
} from '@chief-of-staff/bot';
import {
  calendarAutoCancels,
  calendarItems,
  createDatabase,
  createJobHarness,
  deliveries,
  registerTaskEngine,
  runCalendarScan,
  runMigrations,
  siteConnections,
  taskEvents,
  tasks,
  users,
  withConfirmation,
  type CalendarItem,
  type CalendarScanReport,
  type Database,
  type JobHarness,
  type Task,
  type TaskEvent,
} from '@chief-of-staff/db';
import { startTestPostgres, type TestPostgres } from '@chief-of-staff/db/testing';
import {
  startFakegymFixture,
  type FakegymControl,
  type FixtureHandle,
} from '@chief-of-staff/fixtures';
import {
  CODE_QUESTION,
  createCancellationPlanner,
  createPlaybookMission,
  createPlaybookRegistry,
  fakegymCancellation,
  type CredentialSource,
  type PlaybookRegistry,
} from '@chief-of-staff/playbooks';
import { createLocalProvider, type BrowserProvider } from '@chief-of-staff/solari';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The one suite in the workspace that reaches a real phone.
 *
 * Everything else proves the calendar's two paths against a scripted person
 * and a stood-in Telegram, which pins the routing exactly and cannot notice
 * the thing that actually goes wrong in production: a token Telegram no
 * longer honours, a chat the bot was never let into, a question that arrives
 * on the phone and a yes that never finds its way back to the task. So this
 * file composes the worker and the bot the way `pnpm worker` and `pnpm bot`
 * compose them - the scan, the confirm gate, the fakegym playbook on a local
 * Chromium, the task engine on pg-boss, the bot long-polling the real Telegram
 * - and then waits for a thumb. Twice: the gate's yes, and the code the gym
 * emailed, which is printed to the terminal and nowhere the bot can read.
 *
 * It sits in the ordinary `integration` project rather than behind a config
 * exclusion, so the ordinary gate still loads, typechecks and lints it. The
 * guard below is what stops it messaging anyone: `node scripts/live-telegram.mjs`
 * is how a person says yes on purpose.
 */

const skipReason = liveTelegramSkipReason(process.env);

/** The reason rides in the suite name, so an ordinary run reports why it skipped. */
const suiteName =
  skipReason === undefined
    ? 'the live Telegram round-trip @live-telegram'
    : `the live Telegram round-trip @live-telegram — ${skipReason}`;

/** How long one question waits for a thumb. A person is allowed to be away from the phone, briefly. */
const REPLY_WINDOW_MS = 5 * 60_000;
/** Two questions, and a browser that needs a moment either side of each. */
const ROUND_TRIP_TIMEOUT_MS = 2 * REPLY_WINDOW_MS + 120_000;
/** How often the task row is looked at while the phone is being waited on. */
const POLL_MS = 1_000;

const MEMBER = {
  id: 'ada',
  email: 'ada@example.test',
  password: 'analytical-engine',
  name: 'Ada',
} as const;

/** What the bot says to anything that is not an answer: this process carries replies, and is not the assistant. */
const NOT_THE_ASSISTANT =
  'This is the live round-trip proof, not the assistant: I only carry a reply to the question the job asked. Answer that and I will pass it on.';

const token = (process.env[TELEGRAM_TOKEN_VARIABLE] ?? '').trim();
const chatId = (process.env[TELEGRAM_LIVE_CHAT_VARIABLE] ?? '').trim();

let postgres: TestPostgres;
let database: Database;
let gym: FixtureHandle<FakegymControl>;
let provider: BrowserProvider;
let harness: JobHarness;
let runtime: BotRuntime;
let registry: PlaybookRegistry;
let userId: string;

/** The member's password, from the test and nowhere in the database. */
const memberPassword: CredentialSource = () =>
  Promise.resolve({ kind: 'password', username: MEMBER.email, password: MEMBER.password });

describe.skipIf(skipReason !== undefined)(suiteName, () => {
  beforeAll(async () => {
    [postgres, gym] = await Promise.all([startTestPostgres(), startFakegymFixture()]);
    await runMigrations(postgres.connectionString);
    database = createDatabase(postgres.connectionString);
    provider = createLocalProvider();

    // The phone's chat, bound to a throwaway person the way `/start <code>`
    // binds it in production, so the bot's ordinary binding gate lets the
    // answer through and the question has somebody to go to.
    const [user] = await database.db
      .insert(users)
      .values({ email: `${randomUUID()}@example.test`, tz: 'UTC', telegramChatId: chatId })
      .returning();
    if (user === undefined) throw new Error('the user insert returned no row');
    userId = user.id;
    await database.db
      .insert(siteConnections)
      .values({ userId, siteDomain: new URL(gym.url).host, solariProfileId: 'gym-profile' });
    await gym.control.seedMember(MEMBER);

    harness = createJobHarness({
      connectionString: postgres.connectionString,
      schema: 'pgboss_live_telegram',
      pollingIntervalSeconds: 0.5,
    });
    await harness.start();
    // The bot as `pnpm bot` runs it: the real token, long-polling, the ledger
    // sink over this harness. The chat loop is a sentence, because the only
    // words expected from the phone are answers.
    runtime = createBotRuntime({
      config: loadBotConfig({
        TELEGRAM_BOT_TOKEN: token,
        DATABASE_URL: postgres.connectionString,
        TELEGRAM_TRANSPORT: 'polling',
      }),
      db: database.db,
      harness,
      chatLoop: { respond: () => Promise.resolve(NOT_THE_ASSISTANT) },
    });
    // The worker as `pnpm worker` runs it, on the same harness: the engine,
    // the confirm-gated fakegym playbook, and questions out through the bot's
    // own door rather than a second one on the same token.
    registry = createPlaybookRegistry([fakegymCancellation({ origin: gym.url })]);
    await registerTaskEngine({
      db: database.db,
      mission: withConfirmation(
        createPlaybookMission({ db: database.db, provider, registry, credentials: memberPassword }),
      ),
      userIO: createTelegramUserIO(runtime.sendToUser),
      waitingUserTimeoutMs: REPLY_WINDOW_MS,
    })(harness);
    await runtime.start();
    say(`polling as the bot; questions go to chat ${chatId}`);
  }, 120_000);

  afterAll(async () => {
    try {
      await runtime.stop();
    } finally {
      try {
        await harness.stop();
      } finally {
        try {
          await provider.dispose();
        } finally {
          await gym.stop();
          await database.close();
          await postgres.stop();
        }
      }
    }
  }, 60_000);

  it(
    'delivers a real reminder to the phone',
    async () => {
      const entry = await createEntry({ name: 'Live round-trip reminder', amountCents: 1200 });

      const report = await scan();

      expect(report).toMatchObject({ due: 1, delivered: 1, failed: 0, skipped: 0 });
      const sent = (await database.db.select().from(deliveries)).filter((row) => row.userId === userId);
      expect(sent.map((row) => row.status)).toEqual(['sent']);
      say(`delivered a reminder about "${entry.name}" to chat ${chatId}: ${sent[0]?.text ?? ''}`);
    },
    60_000,
  );

  it(
    'carries a real yes, then a real code, back to the cancellation task, which cancels on the fixture',
    async () => {
      const startedAt = Date.now();
      const entry = await createEntry({
        name: 'Gym',
        amountCents: 4500,
        autoCancel: true,
        autoCancelLeadDays: 3,
        action: { site: 'fakegym' },
      });

      const report = await scan();

      expect(report).toMatchObject({ delivered: 1, enqueued: 1, unlinked: 0 });
      const arm = (await database.db.select().from(calendarAutoCancels)).find(
        (row) => row.itemId === entry.id,
      );
      if (arm === undefined || arm.taskId === null) throw new Error('the scan armed no cancellation task');
      const taskId = arm.taskId;
      say(
        `task ${taskId} is asking chat ${chatId} whether to cancel. On the phone: reply "yes" within ${String(REPLY_WINDOW_MS / 60_000)} minutes.`,
      );
      // The gym's code is read from the fixture's control plane, which the
      // playbook cannot reach: the words typed on the phone are the only way
      // it gets to the task.
      const code = await gym.control.confirmationCode(MEMBER.id);
      say(`when the bot then asks for the confirmation code, reply: ${code}`);

      const task = await settledTask(taskId, ROUND_TRIP_TIMEOUT_MS - 30_000);
      const trail = await eventsOf(taskId);
      const asked = trail
        .filter((event) => event.type === 'ask_user')
        .map((event) => (event.payload as AskUserEventPayload).question);
      const replies = trail
        .filter((event) => event.type === 'user_reply')
        .map((event) => (event.payload as { reply: string }).reply);

      expect(task.status).toBe('succeeded');
      expect(asked).toHaveLength(2);
      expect(asked[0]).toContain('Cancel Gym before it renews on');
      expect(asked[1]).toBe(CODE_QUESTION);
      expect(replies).toHaveLength(2);
      expect(replies[1]).toBe(code);
      expect((await gym.control.member(MEMBER.id)).status).toBe('cancelled');

      // The next scan writes the ending onto the entry, as the hourly one would.
      expect((await scan()).settled).toBe(1);
      expect((await entryOf(entry.id)).annotation).toBe('handled');

      say(
        JSON.stringify({
          live_telegram_roundtrip: {
            ran_at: new Date(startedAt).toISOString(),
            task_id: taskId,
            questions_asked: asked.length,
            replies_carried: replies.length,
            elapsed_ms: Date.now() - startedAt,
            member: 'cancelled',
          },
        }),
      );
    },
    ROUND_TRIP_TIMEOUT_MS,
  );
});

/** One scan now, over the bot's door and the worker's planner, with the morning hour waived. */
function scan(): Promise<CalendarScanReport> {
  return runCalendarScan({
    db: database.db,
    harness,
    send: createReminderSender(runtime.sendToUser),
    sendFromHour: 0,
    cancellations: createCancellationPlanner({ db: database.db, registry }),
  });
}

/** A subscription on its lead day: three days out, three days of lead. */
async function createEntry(
  overrides: Partial<typeof calendarItems.$inferInsert> & { readonly name: string },
): Promise<CalendarItem> {
  const [item] = await database.db
    .insert(calendarItems)
    .values({
      userId,
      kind: 'subscription',
      renewOn: daysFromToday(3),
      reminderLeadDays: 3,
      ...overrides,
    })
    .returning();
  if (item === undefined) throw new Error('the item insert returned no row');
  return item;
}

function daysFromToday(days: number): IsoDate {
  const day = new Date(`${calendarDayIn(new Date(), 'UTC')}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

// This suite, like the rest of the root suite, reads tables whole and filters
// here rather than taking a dependency on the query builder's operators.

async function entryOf(itemId: string): Promise<CalendarItem> {
  const item = (await database.db.select().from(calendarItems)).find((row) => row.id === itemId);
  if (item === undefined) throw new Error(`entry ${itemId} vanished`);
  return item;
}

async function taskOf(taskId: string): Promise<Task> {
  const task = (await database.db.select().from(tasks)).find((row) => row.id === taskId);
  if (task === undefined) throw new Error(`task ${taskId} vanished`);
  return task;
}

async function eventsOf(taskId: string): Promise<TaskEvent[]> {
  return (await database.db.select().from(taskEvents))
    .filter((row) => row.taskId === taskId)
    .sort((a, b) => a.seq - b.seq);
}

/** The task once it has ended, however it ended; or the reason it had not by the deadline. */
async function settledTask(taskId: string, withinMs: number): Promise<Task> {
  const deadline = Date.now() + withinMs;
  let last = '';
  while (Date.now() < deadline) {
    const task = await taskOf(taskId);
    if (isTerminalTaskStatus(task.status)) return task;
    if (task.status !== last) {
      last = task.status;
      say(`task ${taskId} is ${task.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  const trail = await eventsOf(taskId);
  throw new Error(
    `task ${taskId} was still ${last} after ${String(withinMs)}ms; its last event was ${JSON.stringify(trail.at(-1) ?? null)}`,
  );
}

/** Straight to the terminal, past the test reporter: the person at the phone is reading this. */
function say(line: string): void {
  process.stdout.write(`\n[live-telegram] ${line}\n`);
}
