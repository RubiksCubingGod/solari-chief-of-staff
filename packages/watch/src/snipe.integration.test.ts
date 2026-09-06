import { randomUUID } from 'node:crypto';

import type { ExtractorCreator } from '@chief-of-staff/agent';
import {
  BOOK_SLOT_TASK_KIND,
  EXTRACTOR_SPEC_VERSION,
  bookSlotRefusal,
  bookingDedupKey,
  createRecordingNotifier,
  parseBookSlotBooked,
  parserForKind,
  replayExtractor,
  scriptedUserIO,
  triggerDedupKey,
  type BookingEvent,
  type ExtractorSpec,
  type RecordingNotifier,
  type ScriptedReply,
  type SlotCondition,
  type SlotsValue,
  type StepEventPayload,
  type TransitionEventPayload,
  type UserAnswerSink,
  type UserIO,
  type UserQuestion,
  type WatchRecord,
} from '@chief-of-staff/core';
import {
  createDatabase,
  createJobHarness,
  createUserAnswerSink,
  readTaskTimeline,
  registerTaskEngine,
  runMigrations,
  runWorker,
  tasks,
  users,
  watches,
  type Database,
  type JobHarness,
  type TaskLedger,
  type TaskTimeline,
} from '@chief-of-staff/db';
import { startTestPostgres, type TestPostgres } from '@chief-of-staff/db/testing';
import { startFakedmvFixture, type FakedmvControl, type FixtureHandle } from '@chief-of-staff/fixtures';
import { confirmQuestion, createPlaybookMission, createPlaybookRegistry, fakedmvBooking } from '@chief-of-staff/playbooks';
import { createLocalProvider, type BrowserProvider } from '@chief-of-staff/solari';
import { asc } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerWatchEngine } from './check.js';
import { createFetchLadder, type FetchLadder } from './fetch/ladder.js';
import { WATCH_CHECK_QUEUE } from './scheduler.js';
import { SNIPE_STEP, WATCH_SNIPE_QUEUE, settleSnipe } from './snipe.js';
import { createDrizzleWatchStore } from './store.js';

/**
 * The whole reflex on one worker, the way `scripts/worker.mjs` runs it: the
 * watch engine ticks a slot watch on fakedmv, the trigger arms a `book_slot`
 * task, the task engine runs the booking playbook through a local Chromium,
 * a person answers at the gate, and the snipe consequences settle the watch
 * by what the task came to - through the engine's settled hook when this
 * worker settled it, and through the sweep when a channel did.
 *
 * Every case asserts three things at the end: the watch row, the fixture's
 * calendar and bookings, and what the person was told. Booked means booked;
 * a slot that went re-arms the watch and says so; a person who passed keeps
 * the watch from offering the same slot again; a site that blocks the
 * booking leaves the watch paused for attention rather than quietly retrying.
 */

let postgres: TestPostgres;
let database: Database;
let userId: string;
let dmv: FixtureHandle<FakedmvControl>;
let provider: BrowserProvider;
let ladder: FetchLadder;
let store: ReturnType<typeof createDrizzleWatchStore>;
const started: JobHarness[] = [];

const SLOT_SELECTOR = '.dmv-slot .dmv-when';

const SLOT_SPEC: ExtractorSpec = {
  version: EXTRACTOR_SPEC_VERSION,
  strategy: 'css',
  selector: SLOT_SELECTOR,
  attribute: null,
  parse: 'slots',
};

const CONDITION: SlotCondition = {
  kind: 'slot',
  site: 'fakedmv',
  applicant: { name: 'Ada Lovelace' },
  auto_book: false,
};

const TUESDAY = { id: 'tue-0900', startsAt: '2026-09-08T09:00:00Z', label: 'Tue 8 Sep, 09:00' };
const THURSDAY = { id: 'thu-1400', startsAt: '2026-09-10T14:00:00Z', label: 'Thu 10 Sep, 14:00' };
const TUESDAY_SLOT = { id: TUESDAY.label, label: TUESDAY.label };
const REFERENCE = /^DMV-\d{6}$/u;

const NO_SLOTS: SlotsValue = { kind: 'slots', slots: [] };
const TUESDAY_LISTED: SlotsValue = { kind: 'slots', slots: [TUESDAY_SLOT] };

/** A cron that will not fire during a test: ticks here are enqueued by hand. */
const QUIET_CRON = '0 0 1 1 *';

beforeAll(async () => {
  [postgres, dmv] = await Promise.all([startTestPostgres(), startFakedmvFixture()]);
  await runMigrations(postgres.connectionString);
  database = createDatabase(postgres.connectionString);
  store = createDrizzleWatchStore(database);
  const [user] = await database.db.insert(users).values({ telegramChatId: '4245' }).returning();
  if (user === undefined) throw new Error('expected the user row back');
  userId = user.id;
  provider = createLocalProvider();
  ladder = createFetchLadder({ provider, http: { timeoutMs: 10_000 } });
  // An empty calendar in normal mode is the baseline `reset` restores.
  await dmv.control.seed({ slots: [], mode: 'normal' });
});

beforeEach(async () => {
  await dmv.control.reset();
});

afterEach(async () => {
  for (const harness of started.splice(0)) await harness.stop();
  expect(provider.liveSessionIds()).toEqual([]);
  await database.db.delete(tasks);
  await database.db.delete(watches);
});

afterAll(async () => {
  await provider.dispose();
  await dmv.stop();
  await database.close();
  await postgres.stop();
});

/** A creator that always proposes the calendar's selector, replayed as the real creator does. */
const proposing: ExtractorCreator = {
  create(request) {
    const spec: ExtractorSpec = {
      version: EXTRACTOR_SPEC_VERSION,
      strategy: 'css',
      selector: SLOT_SELECTOR,
      attribute: null,
      parse: parserForKind(request.kind),
    };
    const replay = replayExtractor(spec, request.html);
    return Promise.resolve(
      replay.ok
        ? { ok: true, spec, value: replay.value, rationale: null }
        : { ok: false, failure: 'replay-failed', reason: `${SLOT_SELECTOR} did not replay` },
    );
  },
};

async function insertWatch(overrides: Partial<typeof watches.$inferInsert> = {}): Promise<WatchRecord> {
  const [row] = await database.db
    .insert(watches)
    .values({
      userId,
      kind: 'slot',
      url: `${dmv.url}/appointments`,
      extractor: SLOT_SPEC,
      condition: { site: 'fakedmv', applicant: { name: 'Ada Lovelace' } },
      schedule: QUIET_CRON,
      lastValue: NO_SLOTS,
      ...overrides,
    })
    .returning();
  if (row === undefined) throw new Error('expected the watch row back');
  return reload(row.id);
}

async function reload(id: string): Promise<WatchRecord> {
  const watch = await store.loadWatch(id);
  if (watch === undefined) throw new Error(`watch ${id} vanished`);
  return watch;
}

async function tasksOf(): Promise<(typeof tasks.$inferSelect)[]> {
  return database.db.select().from(tasks).orderBy(asc(tasks.createdAt));
}

interface Worker {
  readonly harness: JobHarness;
  readonly ledger: TaskLedger;
  readonly notifier: RecordingNotifier;
  /** Every question the engine put in front of the person, oldest first. */
  readonly asked: readonly UserQuestion[];
}

interface WorkerOptions {
  readonly script?: readonly ScriptedReply[];
  /** A person of the test's own making, given the sink; wins over the script. */
  readonly person?: (sink: UserAnswerSink, asked: UserQuestion[]) => UserIO;
}

/**
 * The worker as production composes it: both engines on one harness, the
 * booking playbook in the registry, the snipe consequences behind the task
 * engine's settled hook, and one recording notifier for everything the
 * person is told.
 */
async function bootWorker(options: WorkerOptions = {}): Promise<Worker> {
  const harness = createJobHarness({
    connectionString: postgres.connectionString,
    schema: `pgboss_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    pollingIntervalSeconds: 0.5,
    cronIntervalSeconds: 1,
  });
  const ledger: TaskLedger = { db: database.db, harness };
  const sink = createUserAnswerSink(ledger);
  const asked: UserQuestion[] = [];
  let userIO: UserIO;
  if (options.person === undefined) {
    const scripted = scriptedUserIO(sink, options.script ?? []);
    userIO = {
      async ask(question) {
        asked.push(question);
        await scripted.ask(question);
      },
    };
  } else {
    userIO = options.person(sink, asked);
  }
  const notifier = createRecordingNotifier();
  const snipe = { db: database, notifier };
  const registry = createPlaybookRegistry([fakedmvBooking({ origin: dmv.url })]);
  const mission = createPlaybookMission({ db: database.db, provider, registry });
  await runWorker(harness, [
    registerWatchEngine({ db: database, ladder, creator: proposing, notifier }),
    registerTaskEngine({
      db: database.db,
      mission,
      userIO,
      settled: (taskId) => settleSnipe(snipe, taskId),
    }),
  ]);
  started.push(harness);
  return { harness, ledger, notifier, asked };
}

async function completed(harness: JobHarness, queue: string, jobId: string): Promise<void> {
  await vi.waitFor(
    async () => {
      expect((await harness.inspect(queue, jobId))?.state).toBe('completed');
    },
    { timeout: 30_000, interval: 100 },
  );
}

/** One scheduled check, by hand. */
async function tick(worker: Worker, watchId: string): Promise<void> {
  await completed(worker.harness, WATCH_CHECK_QUEUE, await worker.harness.enqueue(WATCH_CHECK_QUEUE, { watchId }));
}

/** One snipe sweep, by hand: what the cron does once a minute. */
async function sweep(worker: Worker): Promise<void> {
  await completed(worker.harness, WATCH_SNIPE_QUEUE, await worker.harness.enqueue(WATCH_SNIPE_QUEUE, {}));
}

async function timelineOf(taskId: string): Promise<TaskTimeline> {
  const timeline = await readTaskTimeline(database.db, taskId);
  if (timeline === undefined) throw new Error(`task ${taskId} vanished`);
  return timeline;
}

function steps(timeline: TaskTimeline, name: string): StepEventPayload[] {
  return timeline.events
    .filter((event) => event.type === 'step')
    .map((event) => event.payload as StepEventPayload)
    .filter((step) => step.name === name);
}

function lastTransition(timeline: TaskTimeline): TransitionEventPayload {
  const last = timeline.events
    .filter((event) => event.type === 'transition')
    .map((event) => event.payload as TransitionEventPayload)
    .at(-1);
  if (last === undefined) throw new Error('no transition on the trail');
  return last;
}

/** The task once the snipe consequence is on its trail: settled, and the watch dealt with. */
function snipeSettled(taskId: string): Promise<TaskTimeline> {
  return vi.waitFor(
    async () => {
      const timeline = await timelineOf(taskId);
      expect(steps(timeline, SNIPE_STEP)).not.toEqual([]);
      return timeline;
    },
    { timeout: 120_000, interval: 250 },
  );
}

function waitForStatus(taskId: string, status: string): Promise<TaskTimeline> {
  return vi.waitFor(
    async () => {
      const timeline = await timelineOf(taskId);
      expect(timeline.task.status).toBe(status);
      return timeline;
    },
    { timeout: 120_000, interval: 250 },
  );
}

/** The one task a tick armed, or a failure naming what is there instead. */
async function armedTask(): Promise<typeof tasks.$inferSelect> {
  const [task, ...rest] = await tasksOf();
  if (task === undefined || rest.length > 0) throw new Error(`expected one task, found ${String(rest.length + (task === undefined ? 0 : 1))}`);
  return task;
}

function bookingEvents(notifier: RecordingNotifier): BookingEvent[] {
  return notifier.events.filter((event): event is BookingEvent => event.type === 'booking');
}

/** What every booking event carries: the task, the slot, the watch and the person. */
function bookingEvent(watch: WatchRecord, taskId: string, outcome: BookingEvent['outcome']): Partial<BookingEvent> {
  return {
    type: 'booking',
    watchId: watch.id,
    userId,
    url: watch.url,
    occurredAt: expect.any(String) as string,
    dedupKey: bookingDedupKey(watch.id, taskId, outcome),
    taskId,
    slot: TUESDAY_SLOT,
    outcome,
  };
}

/** A person who does one thing to the site between the question and their yes. */
function slowPerson(meanwhile: () => Promise<void>): NonNullable<WorkerOptions['person']> {
  return (sink, asked) => ({
    async ask(question) {
      asked.push(question);
      if (asked.length === 1) await meanwhile();
      await sink.resolve(question.taskId, question.questionId, { kind: 'answer', reply: 'yes' });
    },
  });
}

describe('the snipe, end to end', () => {
  it('releases, detects, asks, books, and tells the person - and leaves the watch paused on its booking', async () => {
    const worker = await bootWorker({ script: [{ kind: 'answer', reply: 'yes' }] });
    const watch = await insertWatch();
    await dmv.control.publishSlot(TUESDAY);

    await tick(worker, watch.id);
    const task = await armedTask();
    expect(task).toMatchObject({ userId, kind: BOOK_SLOT_TASK_KIND, mode: 'playbook' });

    const timeline = await snipeSettled(task.id);

    // Booked means booked: the fixture's record, and its reference on the task.
    expect(timeline.task.status).toBe('succeeded');
    const [booking, ...moreBookings] = await dmv.control.bookings();
    expect(moreBookings).toEqual([]);
    expect(booking).toMatchObject({ slotId: TUESDAY.id, name: 'Ada Lovelace', reference: expect.stringMatching(REFERENCE) as string });
    expect(parseBookSlotBooked(timeline.task.result)).toEqual({ reference: booking?.reference, bookedAt: booking?.bookedAt });
    expect((await dmv.control.slots()).map((slot) => slot.status)).toEqual(['taken']);

    // The watch stays paused: its job is done, and a booked calendar is not one to keep sniping.
    expect(await reload(watch.id)).toMatchObject({ status: 'paused', lastValue: TUESDAY_LISTED });
    expect(steps(timeline, SNIPE_STEP)).toEqual([
      { name: SNIPE_STEP, outcome: 'booked', detail: { watchId: watch.id, reason: `${TUESDAY.label} is booked: reference ${booking?.reference ?? ''}` } },
    ]);

    // The person heard about the sighting, was asked, and heard the outcome.
    expect(worker.asked.map((question) => question.question)).toEqual([
      confirmQuestion({ site: 'fakedmv', watchId: watch.id, url: watch.url, slot: TUESDAY_SLOT, applicant: CONDITION.applicant, auto_book: false }),
    ]);
    expect(worker.notifier.events.map((event) => event.type)).toEqual(['triggered', 'booking']);
    expect(worker.notifier.events[0]).toMatchObject({ dedupKey: triggerDedupKey(watch.id, CONDITION, TUESDAY_LISTED) });
    expect(bookingEvents(worker.notifier)).toEqual([
      {
        ...bookingEvent(watch, task.id, 'booked'),
        reference: booking?.reference,
        reason: `${TUESDAY.label} is booked: reference ${booking?.reference ?? ''}`,
      },
    ]);

    // A sweep after the fact finds the consequence already on the trail and does nothing again.
    const calls = worker.notifier.calls.length;
    await sweep(worker);
    expect(worker.notifier.calls).toHaveLength(calls);
    expect(steps(await timelineOf(task.id), SNIPE_STEP)).toHaveLength(1);
    expect(await reload(watch.id)).toMatchObject({ status: 'paused' });
    // And a tick on the paused watch fetches nothing and arms nothing.
    await tick(worker, watch.id);
    expect(await tasksOf()).toHaveLength(1);
  });

  it('loses gracefully: a slot yanked before the booking re-arms the watch, tells the person, and a later release books', async () => {
    const worker = await bootWorker({ person: slowPerson(() => dmv.control.withdrawSlot(TUESDAY.id)) });
    const watch = await insertWatch();
    await dmv.control.publishSlot(TUESDAY);

    await tick(worker, watch.id);
    const first = await armedTask();
    const lost = await snipeSettled(first.id);

    // The booking arm found the calendar empty at its re-check: refused, slot gone, nothing booked.
    expect(lost.task.status).toBe('failed');
    expect(lastTransition(lost)).toMatchObject({ cause: 'refused' });
    expect(bookSlotRefusal(lastTransition(lost).detail)).toBe('slot-gone');
    expect(await dmv.control.state()).toMatchObject({ slots: [], bookings: [] });

    // The watch is active again with no baseline: the same slot listed again will be news.
    expect(await reload(watch.id)).toMatchObject({ status: 'active', lastValue: null, consecutiveFailures: 0 });
    expect(steps(lost, SNIPE_STEP)).toEqual([
      {
        name: SNIPE_STEP,
        outcome: 'rearmed',
        detail: { watchId: watch.id, reason: `availability: fakedmv no longer offers ${TUESDAY.label}`, clearBaseline: true, moved: true },
      },
    ]);
    expect(bookingEvents(worker.notifier)).toEqual([
      { ...bookingEvent(watch, first.id, 'rearmed'), reference: null, reason: `availability: fakedmv no longer offers ${TUESDAY.label}` },
    ]);

    // A fresh check reads the empty calendar: no stale trigger from the old observation.
    await tick(worker, watch.id);
    expect(await tasksOf()).toHaveLength(1);
    expect(await reload(watch.id)).toMatchObject({ status: 'active', lastValue: NO_SLOTS });

    // The slot comes back, and this time the person is quick.
    await dmv.control.publishSlot(TUESDAY);
    await tick(worker, watch.id);
    const [, second] = await tasksOf();
    if (second === undefined) throw new Error('the release armed no second task');
    const won = await snipeSettled(second.id);

    expect(won.task.status).toBe('succeeded');
    const [booking] = await dmv.control.bookings();
    expect(booking).toMatchObject({ slotId: TUESDAY.id, reference: expect.stringMatching(REFERENCE) as string });
    expect(parseBookSlotBooked(won.task.result)?.reference).toBe(booking?.reference);
    expect(await reload(watch.id)).toMatchObject({ status: 'paused', lastValue: TUESDAY_LISTED });
    expect(worker.asked).toHaveLength(2);
    expect(bookingEvents(worker.notifier).map((event) => [event.taskId, event.outcome])).toEqual([
      [first.id, 'rearmed'],
      [second.id, 'booked'],
    ]);
    // The second sighting is the same slot on the same watch: one trigger event, delivered twice.
    expect(worker.notifier.events.filter((event) => event.type === 'triggered')).toHaveLength(1);
    expect(worker.notifier.calls.filter((event) => event.type === 'triggered')).toHaveLength(2);
  });

  it('re-arms the watch through the sweep when the person declines, keeping the declined slot from being offered again', async () => {
    const worker = await bootWorker({ script: [{ kind: 'decline' }, { kind: 'ignore' }] });
    const watch = await insertWatch();
    await dmv.control.publishSlot(TUESDAY);

    await tick(worker, watch.id);
    const task = await armedTask();
    const declined = await waitForStatus(task.id, 'cancelled');

    // A decline settles the task from the channel, not from a run: no hook fires, and the watch waits for the sweep.
    expect(lastTransition(declined)).toMatchObject({ cause: 'declined' });
    expect(steps(declined, SNIPE_STEP)).toEqual([]);
    expect(await reload(watch.id)).toMatchObject({ status: 'paused', lastValue: TUESDAY_LISTED });
    expect(bookingEvents(worker.notifier)).toEqual([]);

    await sweep(worker);

    const timeline = await timelineOf(task.id);
    expect(steps(timeline, SNIPE_STEP)).toEqual([
      {
        name: SNIPE_STEP,
        outcome: 'rearmed',
        detail: { watchId: watch.id, reason: `the person declined to book ${TUESDAY.label}`, clearBaseline: false, moved: true },
      },
    ]);
    expect(await reload(watch.id)).toMatchObject({ status: 'active', lastValue: TUESDAY_LISTED });
    expect(bookingEvents(worker.notifier)).toEqual([
      { ...bookingEvent(watch, task.id, 'rearmed'), reference: null, reason: `the person declined to book ${TUESDAY.label}` },
    ]);
    // The slot they passed on is still open, and nothing booked it.
    expect(await dmv.control.state()).toMatchObject({ slots: [{ id: TUESDAY.id, status: 'open' }], bookings: [] });

    // The baseline kept, the declined slot is not news; a slot beside it is.
    await tick(worker, watch.id);
    expect(await tasksOf()).toHaveLength(1);
    expect(await reload(watch.id)).toMatchObject({ status: 'active' });
    await dmv.control.publishSlot(THURSDAY);
    await tick(worker, watch.id);
    expect(await tasksOf()).toHaveLength(2);
    expect(await reload(watch.id)).toMatchObject({ status: 'paused' });
    await vi.waitFor(() => {
      expect(worker.asked).toHaveLength(2);
    }, { timeout: 60_000, interval: 250 });
    expect(worker.asked[1]?.question).toContain(THURSDAY.label);
  });

  it('leaves the watch paused for attention, and says why, when the site blocks the booking', async () => {
    const worker = await bootWorker({ person: slowPerson(() => dmv.control.setMode('hard-blocked')) });
    const watch = await insertWatch();
    await dmv.control.publishSlot(TUESDAY);

    await tick(worker, watch.id);
    const task = await armedTask();
    const timeline = await snipeSettled(task.id);

    // The re-check after the yes met the captcha shell: a failure, not a refusal, and not a retry.
    expect(timeline.task.status).toBe('failed');
    expect(lastTransition(timeline)).toMatchObject({
      cause: 'error',
      detail: { reason: 'availability: fakedmv is showing its blocked shell' },
    });
    expect(await dmv.control.mode()).toBe('hard-blocked');
    expect(await dmv.control.state()).toMatchObject({ slots: [{ id: TUESDAY.id, status: 'open' }], bookings: [] });

    // Paused, with the baseline it triggered on, until a person looks.
    expect(await reload(watch.id)).toMatchObject({ status: 'paused', lastValue: TUESDAY_LISTED });
    expect(steps(timeline, SNIPE_STEP)).toEqual([
      { name: SNIPE_STEP, outcome: 'paused', detail: { watchId: watch.id, reason: 'availability: fakedmv is showing its blocked shell' } },
    ]);
    expect(bookingEvents(worker.notifier)).toEqual([
      { ...bookingEvent(watch, task.id, 'paused'), reference: null, reason: 'availability: fakedmv is showing its blocked shell' },
    ]);

    // Neither the sweep nor a tick moves a watch that is waiting for a person.
    await sweep(worker);
    await tick(worker, watch.id);
    expect(await reload(watch.id)).toMatchObject({ status: 'paused' });
    expect(await tasksOf()).toHaveLength(1);
    expect(bookingEvents(worker.notifier)).toHaveLength(1);
  });
});
