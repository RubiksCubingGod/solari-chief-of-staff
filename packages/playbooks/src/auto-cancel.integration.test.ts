import { randomUUID } from 'node:crypto';

import {
  isTerminalTaskStatus,
  scriptedUserIO,
  type ScriptedReply,
  type ScriptedUserIO,
  type StepEventPayload,
  type TransitionEventPayload,
} from '@chief-of-staff/core';
import {
  calendarAutoCancels,
  calendarItems,
  createDatabase,
  createJobHarness,
  createUserAnswerSink,
  readTaskTimeline,
  registerTaskEngine,
  runCalendarScan,
  runMigrations,
  siteConnections,
  tasks,
  users,
  withConfirmation,
  type CalendarAutoCancel,
  type CalendarItem,
  type CalendarScanReport,
  type Database,
  type JobHarness,
  type NewCalendarItem,
  type TaskLedger,
  type TaskTimeline,
} from '@chief-of-staff/db';
import { startTestPostgres, type TestPostgres } from '@chief-of-staff/db/testing';
import {
  startFakegymFixture,
  type FakegymControl,
  type FixtureHandle,
  type Member,
} from '@chief-of-staff/fixtures';
import { createLocalProvider, type BrowserProvider } from '@chief-of-staff/solari';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createCancellationPlanner } from './auto-cancel.js';
import { CODE_QUESTION, fakegymCancellation } from './fakegym/cancellation.js';
import { createPlaybookMission, createPlaybookRegistry, type CredentialSource } from './runner/index.js';

/**
 * The auto-cancel path (auto-cancel-path spec), composed the way the worker
 * composes it: the calendar scan's auto-cancel arm enqueues a cancellation
 * task for an entry that has reached its lead day, the task engine runs that
 * task through the confirm gate and then the fakegym playbook on a local
 * Chromium, and a person played from a script answers the questions.
 *
 * What is proved is the whole of the spec's path and failure behaviour: one
 * task per renewal whatever the scan does, a yes that ends in a cancelled
 * member and a handled entry, a no and a silence that leave the membership
 * alone and mark the entry, an entry nobody can act on marked for attention
 * with its reminder still sent, and a failed playbook that leaves the entry
 * marked and armed for the next renewal. The Telegram half of the same path
 * is the live proof's business.
 */

const MEMBER = { id: 'ada', email: 'ada@example.test', password: 'analytical-engine', name: 'Ada' } as const;

const RENEW_ON = '2026-09-12';
/** Noon UTC on the lead day of a renewal on the 12th with the default three-day lead. */
const LEAD_DAY_NOON = '2026-09-09T12:00:00Z';
const LATER_THAT_DAY = '2026-09-09T13:00:00Z';
const NEXT_DAY_NOON = '2026-09-10T12:00:00Z';
const NEXT_RENEW_ON = '2026-10-12';
const NEXT_LEAD_DAY_NOON = '2026-10-09T12:00:00Z';

const CONFIRM =
  'Cancel Gym before it renews on 2026-09-12? Amount: 45.00. Reply yes to go ahead, or no to leave it as it is.';
const REMINDER = 'Reminder: Gym renews on 2026-09-12 (in 3 days). Amount: 45.00.';

let postgres: TestPostgres;
let database: Database;
let gym: FixtureHandle<FakegymControl>;
let provider: BrowserProvider;
const harnesses: JobHarness[] = [];

const gymHost = (): string => new URL(gym.url).host;
const member = (): Promise<Member> => gym.control.member(MEMBER.id);

beforeAll(async () => {
  [postgres, gym] = await Promise.all([startTestPostgres(), startFakegymFixture()]);
  await runMigrations(postgres.connectionString);
  database = createDatabase(postgres.connectionString);
  await gym.control.seedMember(MEMBER);
  await gym.control.seed({});
  provider = createLocalProvider();
});

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.stop();
  expect(provider.liveSessionIds()).toEqual([]);
  await gym.control.reset();
  // Every entry, task, connection and mark hangs off a user.
  await database.db.delete(users);
});

afterAll(async () => {
  await provider.dispose();
  await gym.stop();
  await database.close();
  await postgres.stop();
});

/** The member's password, from the test and nowhere in the database. */
const memberPassword: CredentialSource = () =>
  Promise.resolve({ kind: 'password', username: MEMBER.email, password: MEMBER.password });

const wrongPassword: CredentialSource = () =>
  Promise.resolve({ kind: 'password', username: MEMBER.email, password: 'difference-engine' });

interface Worker {
  readonly ledger: TaskLedger;
  readonly io: ScriptedUserIO;
  /** Every reminder the scan sent, oldest first. */
  readonly reminders: string[];
  /** One scan at the given instant, on this worker's harness. */
  scan(at: string): Promise<CalendarScanReport>;
}

interface WorkerOptions {
  readonly script?: readonly ScriptedReply[];
  readonly credentials?: CredentialSource;
  readonly waitingUserTimeoutMs?: number;
}

/** A worker with the engine, the confirm-gated fakegym playbook and the scan on it, on its own pg-boss schema. */
async function startWorker(options: WorkerOptions = {}): Promise<Worker> {
  const harness = createJobHarness({
    connectionString: postgres.connectionString,
    schema: `pgboss_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    pollingIntervalSeconds: 0.5,
  });
  const ledger: TaskLedger = { db: database.db, harness };
  const io = scriptedUserIO(createUserAnswerSink(ledger), options.script ?? []);
  const registry = createPlaybookRegistry([fakegymCancellation({ origin: gym.url })]);
  const mission = withConfirmation(
    createPlaybookMission({
      db: database.db,
      provider,
      registry,
      credentials: options.credentials ?? memberPassword,
    }),
  );
  await harness.start();
  await registerTaskEngine({
    db: database.db,
    mission,
    userIO: io,
    ...(options.waitingUserTimeoutMs === undefined
      ? {}
      : { waitingUserTimeoutMs: options.waitingUserTimeoutMs }),
  })(harness);
  harnesses.push(harness);
  const reminders: string[] = [];
  return {
    ledger,
    io,
    reminders,
    scan: (at) =>
      runCalendarScan({
        db: database.db,
        harness,
        now: () => new Date(at),
        send: (_userId, text) => {
          reminders.push(text);
          return Promise.resolve({ kind: 'sent' });
        },
        cancellations: createCancellationPlanner({ db: database.db, registry }),
      }),
  };
}

/** A person with a chat to be asked over and, unless told otherwise, a connected gym. */
async function createPerson(
  options: { readonly connected?: boolean; readonly chat?: boolean } = {},
): Promise<string> {
  const [user] = await database.db
    .insert(users)
    .values({
      email: `${randomUUID()}@example.test`,
      tz: 'UTC',
      telegramChatId: options.chat === false ? null : `chat-${randomUUID()}`,
    })
    .returning();
  if (user === undefined) throw new Error('the user insert returned no row');
  if (options.connected !== false) {
    await database.db
      .insert(siteConnections)
      .values({ userId: user.id, siteDomain: gymHost(), solariProfileId: 'gym-profile' });
  }
  return user.id;
}

/** A subscription that asked to be cancelled on the fakegym before it renews. */
async function createEntry(userId: string, overrides: Partial<NewCalendarItem> = {}): Promise<string> {
  const [item] = await database.db
    .insert(calendarItems)
    .values({
      userId,
      kind: 'subscription',
      name: 'Gym',
      amountCents: 4500,
      renewOn: RENEW_ON,
      autoCancel: true,
      action: { site: 'fakegym' },
      ...overrides,
    })
    .returning();
  if (item === undefined) throw new Error('the item insert returned no row');
  return item.id;
}

// This package, like the root suite, reads tables whole and filters here
// rather than taking a dependency on the query builder's operators.

async function entryOf(itemId: string): Promise<CalendarItem> {
  const item = (await database.db.select().from(calendarItems)).find((row) => row.id === itemId);
  if (item === undefined) throw new Error(`entry ${itemId} vanished`);
  return item;
}

async function autoCancelsOf(itemId: string): Promise<CalendarAutoCancel[]> {
  return (await database.db.select().from(calendarAutoCancels))
    .filter((row) => row.itemId === itemId)
    .sort((a, b) => a.renewOn.localeCompare(b.renewOn));
}

/** The one task the arm enqueued for the entry's renewal. */
async function taskOf(itemId: string): Promise<string> {
  const rows = await autoCancelsOf(itemId);
  const taskId = rows[0]?.taskId;
  if (rows.length !== 1 || taskId === null || taskId === undefined) {
    throw new Error(`expected one enqueued auto-cancel for ${itemId}, found ${JSON.stringify(rows)}`);
  }
  return taskId;
}

async function settled(taskId: string, timeoutMs = 90_000): Promise<TaskTimeline> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const timeline = await readTaskTimeline(database.db, taskId);
    if (timeline === undefined) throw new Error(`task ${taskId} vanished`);
    if (isTerminalTaskStatus(timeline.task.status)) return timeline;
    if (Date.now() > deadline) {
      throw new Error(`task ${taskId} still ${timeline.task.status} after ${String(timeoutMs)}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function trail(timeline: TaskTimeline): string[] {
  return timeline.events.map((event) => {
    if (event.type === 'transition') return `transition:${(event.payload as TransitionEventPayload).cause}`;
    if (event.type === 'step') return `step:${(event.payload as StepEventPayload).name}`;
    return event.type;
  });
}

function steps(timeline: TaskTimeline, name: string): StepEventPayload[] {
  return timeline.events
    .filter((event) => event.type === 'step')
    .map((event) => event.payload as StepEventPayload)
    .filter((step) => step.name === name);
}

function lastTransition(timeline: TaskTimeline): TransitionEventPayload | undefined {
  return timeline.events
    .filter((event) => event.type === 'transition')
    .map((event) => event.payload as TransitionEventPayload)
    .at(-1);
}

function asked(worker: Worker): string[] {
  return worker.io.asked.map((question) => question.question);
}

/** The task parked on a question, answered, and picked up again. */
const PARKED = ['ask_user', 'transition:asked', 'user_reply', 'transition:answered', 'transition:resumed'];
/** One walk of the fakegym flow from a fresh session up to the step that needs the code. */
const WALK = [
  'step:browser_session',
  'step:login',
  'step:retention',
  'step:are-you-sure',
  'step:confirmation-code',
];

describe('the auto-cancel arm', () => {
  it('enqueues one confirm-gated task at lead day, and a yes runs the playbook to a cancelled member and a handled entry', async () => {
    const code = await gym.control.confirmationCode(MEMBER.id);
    const worker = await startWorker({
      script: [
        { kind: 'answer', reply: 'yes' },
        { kind: 'answer', reply: code },
      ],
    });
    const userId = await createPerson();
    const itemId = await createEntry(userId);

    // Three scans at once: the renewal is one key, so one of them enqueues.
    const reports = await Promise.all([
      worker.scan(LEAD_DAY_NOON),
      worker.scan(LEAD_DAY_NOON),
      worker.scan(LEAD_DAY_NOON),
    ]);
    expect(reports.reduce((total, report) => total + report.enqueued, 0)).toBe(1);
    expect(reports.reduce((total, report) => total + report.unlinked, 0)).toBe(0);
    const taskId = await taskOf(itemId);
    expect(await autoCancelsOf(itemId)).toMatchObject([
      { renewOn: RENEW_ON, state: 'enqueued', taskId, settledAt: null },
    ]);
    expect(await database.db.select().from(tasks)).toMatchObject([
      { id: taskId, userId, kind: 'cancel', mode: 'playbook', input: { site: 'fakegym', confirm: CONFIRM } },
    ]);
    // The reminder for the same day went out on its own, as its own message.
    expect(worker.reminders).toEqual([REMINDER]);

    const timeline = await settled(taskId);
    expect(timeline.task.status).toBe('succeeded');
    expect((await member()).status).toBe('cancelled');
    expect(asked(worker)).toEqual([CONFIRM, CODE_QUESTION]);
    // The first act is the question, before any browser; the playbook runs
    // only behind the yes, and re-walks from the top after the code, as it
    // always does.
    expect(trail(timeline)).toEqual([
      'transition:started',
      ...PARKED,
      'step:confirm',
      ...WALK,
      ...PARKED,
      'step:confirm',
      ...WALK,
      'transition:succeeded',
    ]);
    expect(steps(timeline, 'confirm')).toEqual([
      { name: 'confirm', outcome: 'confirmed', detail: { question: CONFIRM, reply: 'yes' } },
      { name: 'confirm', outcome: 'confirmed', detail: { question: CONFIRM, reply: 'yes' } },
    ]);
    expect(timeline.task.playbookId).toBe('fakegym.cancel');

    // The next scan writes the ending onto the entry.
    expect(await worker.scan(LATER_THAT_DAY)).toMatchObject({ enqueued: 0, settled: 1 });
    expect(await entryOf(itemId)).toMatchObject({
      annotation: 'handled',
      annotationNote: 'Cancelled on 2026-09-09, ahead of the renewal on 2026-09-12.',
    });
    const [row] = await autoCancelsOf(itemId);
    expect(row).toMatchObject({ state: 'handled', taskId });
    expect(row?.settledAt).not.toBeNull();

    // And the one after finds a story that is over: no task, no reminder, no mark.
    expect(await worker.scan(NEXT_DAY_NOON)).toEqual({
      due: 0,
      delivered: 0,
      late: 0,
      failed: 0,
      skipped: 0,
      enqueued: 0,
      unlinked: 0,
      settled: 0,
    });
    expect(await autoCancelsOf(itemId)).toHaveLength(1);
    expect(await database.db.select().from(tasks)).toHaveLength(1);
  });

  it('cancels the task on a no, leaves the membership alone, and marks the entry declined', async () => {
    const worker = await startWorker({ script: [{ kind: 'decline' }] });
    const userId = await createPerson();
    const itemId = await createEntry(userId);

    expect(await worker.scan(LEAD_DAY_NOON)).toMatchObject({ enqueued: 1 });
    const timeline = await settled(await taskOf(itemId));
    expect(timeline.task.status).toBe('cancelled');
    expect(trail(timeline)).toEqual(['transition:started', 'ask_user', 'transition:asked', 'transition:declined']);
    expect(asked(worker)).toEqual([CONFIRM]);
    expect(steps(timeline, 'browser_session')).toEqual([]);
    expect((await member()).status).toBe('active');

    expect(await worker.scan(LATER_THAT_DAY)).toMatchObject({ settled: 1 });
    expect(await entryOf(itemId)).toMatchObject({
      annotation: 'declined',
      annotationNote: 'You said no to cancelling it before the renewal on 2026-09-12.',
    });
    expect(await autoCancelsOf(itemId)).toMatchObject([{ state: 'declined' }]);

    // A no is the answer for this renewal: the arm does not ask again, and the
    // reminder side carries on as before.
    expect(await worker.scan(NEXT_DAY_NOON)).toMatchObject({ enqueued: 0, unlinked: 0, due: 1 });
    expect(await autoCancelsOf(itemId)).toHaveLength(1);
    expect(await database.db.select().from(tasks)).toHaveLength(1);
  });

  it('fails the task when nobody answers in time, leaves the membership alone, and marks the entry for attention', async () => {
    const worker = await startWorker({ script: [{ kind: 'ignore' }], waitingUserTimeoutMs: 1_500 });
    const userId = await createPerson();
    const itemId = await createEntry(userId);

    expect(await worker.scan(LEAD_DAY_NOON)).toMatchObject({ enqueued: 1 });
    const timeline = await settled(await taskOf(itemId));
    expect(timeline.task.status).toBe('failed');
    expect(lastTransition(timeline)).toMatchObject({ cause: 'timeout' });
    expect(asked(worker)).toEqual([CONFIRM]);
    expect((await member()).status).toBe('active');

    expect(await worker.scan(LATER_THAT_DAY)).toMatchObject({ settled: 1 });
    expect(await entryOf(itemId)).toMatchObject({
      annotation: 'needs_attention',
      annotationNote:
        'The cancellation ahead of the renewal on 2026-09-12 did not happen: nobody answered the question in time.',
    });
    expect(await autoCancelsOf(itemId)).toMatchObject([{ state: 'failed' }]);
  });

  it('marks the entry for attention when the playbook fails behind a yes, and arms again for the next renewal', async () => {
    const worker = await startWorker({
      script: [{ kind: 'answer', reply: 'yes' }],
      credentials: wrongPassword,
    });
    const userId = await createPerson();
    const itemId = await createEntry(userId);

    expect(await worker.scan(LEAD_DAY_NOON)).toMatchObject({ enqueued: 1 });
    const timeline = await settled(await taskOf(itemId));
    expect(timeline.task.status).toBe('failed');
    expect(lastTransition(timeline)).toMatchObject({
      cause: 'error',
      detail: { reason: 'login: fakegym refused the credentials (bad-credentials)' },
    });
    expect((await member()).status).toBe('active');

    expect(await worker.scan(LATER_THAT_DAY)).toMatchObject({ settled: 1 });
    expect(await entryOf(itemId)).toMatchObject({
      annotation: 'needs_attention',
      annotationNote:
        'The cancellation ahead of the renewal on 2026-09-12 did not happen: login: fakegym refused the credentials (bad-credentials).',
    });
    expect(await autoCancelsOf(itemId)).toMatchObject([{ state: 'failed' }]);

    // The renewal moves on, as a renewal does once it has happened; the next
    // one is a new key, so the arm asks afresh. (Every entry there is, which
    // is this one.)
    await database.db.update(calendarItems).set({ renewOn: NEXT_RENEW_ON });
    expect(await worker.scan(NEXT_LEAD_DAY_NOON)).toMatchObject({ enqueued: 1 });
    expect(await autoCancelsOf(itemId)).toMatchObject([
      { renewOn: RENEW_ON, state: 'failed' },
      { renewOn: NEXT_RENEW_ON, state: 'enqueued' },
    ]);
    expect(await database.db.select().from(tasks)).toHaveLength(2);
  });

  it('marks an entry whose site is not connected for attention instead of enqueuing, and still sends its reminder', async () => {
    const worker = await startWorker();
    const userId = await createPerson({ connected: false });
    const itemId = await createEntry(userId);

    expect(await worker.scan(LEAD_DAY_NOON)).toMatchObject({ enqueued: 0, unlinked: 1, delivered: 1 });
    expect(await database.db.select().from(tasks)).toEqual([]);
    expect(await autoCancelsOf(itemId)).toMatchObject([{ renewOn: RENEW_ON, state: 'unlinked', taskId: null }]);
    const marked = await entryOf(itemId);
    expect(marked.annotation).toBe('needs_attention');
    expect(marked.annotationNote).toBe(
      `Auto-cancel could not be armed for the renewal on 2026-09-12: no connected site for ${gymHost()}.`,
    );
    expect(worker.reminders).toEqual([REMINDER]);
    expect(asked(worker)).toEqual([]);

    // The next scan does not mark it again: the row says the decision was made.
    expect(await worker.scan(LATER_THAT_DAY)).toMatchObject({ enqueued: 0, unlinked: 0 });
    expect(await entryOf(itemId)).toMatchObject({ annotatedAt: marked.annotatedAt });
    expect(await autoCancelsOf(itemId)).toHaveLength(1);
  });

  it('marks a flagged entry for attention when there is no chat to ask its person over, and creates no task', async () => {
    const worker = await startWorker();
    const userId = await createPerson({ chat: false });
    const itemId = await createEntry(userId);

    expect(await worker.scan(LEAD_DAY_NOON)).toMatchObject({ enqueued: 0, unlinked: 1 });
    expect(await database.db.select().from(tasks)).toEqual([]);
    expect(await autoCancelsOf(itemId)).toMatchObject([{ renewOn: RENEW_ON, state: 'unlinked', taskId: null }]);
    // Said now, on the entry, rather than a day later as "nobody answered"
    // a question that was never delivered.
    expect((await entryOf(itemId)).annotationNote).toBe('Auto-cancel could not be armed for the renewal on 2026-09-12: no Telegram chat is bound to ask over.');
    expect(asked(worker)).toEqual([]);
  });

  it('is unlinked when no playbook knows the site, or the entry names none', async () => {
    const worker = await startWorker();
    const userId = await createPerson();
    const unknown = await createEntry(userId, { name: 'Cloud', action: { site: 'nowhere' } });
    const unnamed = await createEntry(userId, { name: 'Magazine', action: null });

    expect(await worker.scan(LEAD_DAY_NOON)).toMatchObject({ enqueued: 0, unlinked: 2 });
    expect(await database.db.select().from(tasks)).toEqual([]);
    expect((await entryOf(unknown)).annotationNote).toBe(
      'Auto-cancel could not be armed for the renewal on 2026-09-12: no playbook can cancel on nowhere.',
    );
    expect((await entryOf(unnamed)).annotationNote).toBe(
      'Auto-cancel could not be armed for the renewal on 2026-09-12: the entry names no site to cancel on.',
    );
  });
});
