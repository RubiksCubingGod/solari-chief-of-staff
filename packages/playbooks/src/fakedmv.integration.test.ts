import { randomUUID } from 'node:crypto';

import {
  bookSlotInput,
  bookSlotRefusal,
  isTerminalTaskStatus,
  parseBookSlotBooked,
  scriptedUserIO,
  type BookSlotInput,
  type ScriptedReply,
  type SlotCondition,
  type StepEventPayload,
  type TransitionEventPayload,
  type UserAnswerSink,
  type UserIO,
  type UserQuestion,
} from '@chief-of-staff/core';
import {
  createDatabase,
  createJobHarness,
  createUserAnswerSink,
  enqueueTaskRun,
  readTaskTimeline,
  registerTaskEngine,
  runMigrations,
  siteConnections,
  tasks,
  users,
  type Database,
  type JobHarness,
  type Task,
  type TaskLedger,
  type TaskTimeline,
} from '@chief-of-staff/db';
import { startTestPostgres, type TestPostgres } from '@chief-of-staff/db/testing';
import { startFakedmvFixture, type Booking, type FakedmvControl, type FixtureHandle, type Slot } from '@chief-of-staff/fixtures';
import { createLocalProvider, type BrowserProvider } from '@chief-of-staff/solari';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { confirmQuestion, fakedmvBooking } from './fakedmv/booking.js';
import { createPlaybookMission, createPlaybookRegistry } from './runner/index.js';

/**
 * The booking playbook against the fakedmv fixture, driven the way production
 * drives it: a `book_slot` task in Postgres with the input a slot watch
 * writes, the engine on a pg-boss worker, a local Chromium behind the
 * provider seam, and a person played from a script at the confirm gate.
 *
 * "Booked means booked": the booked path asserts the fixture's booking record
 * and the reference on the task. Every path that does not book asserts the
 * fixture afterwards - no booking, the slot as it was - because a task that
 * failed is only half the claim.
 */

const TUESDAY = { id: 'tue-0900', startsAt: '2026-09-08T09:00:00Z', label: 'Tue 8 Sep, 09:00' } as const;
const APPLICANT = { name: 'Ada Lovelace' } as const;
const REFERENCE = /^DMV-\d{6}$/u;

let postgres: TestPostgres;
let database: Database;
let dmv: FixtureHandle<FakedmvControl>;
let provider: BrowserProvider;
let userId: string;
const harnesses: JobHarness[] = [];

beforeAll(async () => {
  [postgres, dmv] = await Promise.all([startTestPostgres(), startFakedmvFixture()]);
  await runMigrations(postgres.connectionString);
  database = createDatabase(postgres.connectionString);
  const [user] = await database.db
    .insert(users)
    .values({ email: `${randomUUID()}@example.test` })
    .returning();
  if (user === undefined) throw new Error('the user insert returned no row');
  userId = user.id;
  // The DMV has no account to sign in to: no site connection, ever.
  await expect(database.db.select().from(siteConnections)).resolves.toEqual([]);
  // Tuesday is the baseline `reset` restores, open.
  await dmv.control.seed({ slots: [TUESDAY] });
  provider = createLocalProvider();
});

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.stop();
  expect(provider.liveSessionIds()).toEqual([]);
  await dmv.control.reset();
});

afterAll(async () => {
  await provider.dispose();
  await dmv.stop();
  await database.close();
  await postgres.stop();
});

function condition(autoBook: boolean): SlotCondition {
  return { kind: 'slot', site: 'fakedmv', applicant: APPLICANT, auto_book: autoBook };
}

/** The input the slot trigger writes: the watch's page, the slot the comparator picked, the applicant. */
function input(autoBook = false): BookSlotInput {
  return bookSlotInput(
    { id: randomUUID(), url: `${dmv.url}/appointments` },
    condition(autoBook),
    { id: TUESDAY.label, label: TUESDAY.label },
  );
}

interface Worker {
  readonly ledger: TaskLedger;
  readonly asked: readonly UserQuestion[];
}

interface WorkerOptions {
  readonly script?: readonly ScriptedReply[];
  /** A person of the test's own making, given the sink; wins over the script. */
  readonly person?: (sink: UserAnswerSink, asked: UserQuestion[]) => UserIO;
}

/** A worker with the engine and the fakedmv playbook on it, on its own pg-boss schema, with no credential source: the DMV asks for none. */
async function startWorker(options: WorkerOptions = {}): Promise<Worker> {
  const harness = createJobHarness({
    connectionString: postgres.connectionString,
    schema: `pgboss_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    pollingIntervalSeconds: 0.5,
  });
  const ledger: TaskLedger = { db: database.db, harness };
  const sink = createUserAnswerSink(ledger);
  const asked: UserQuestion[] = [];
  let io: UserIO;
  if (options.person === undefined) {
    const scripted = scriptedUserIO(sink, options.script ?? []);
    io = {
      async ask(question) {
        asked.push(question);
        await scripted.ask(question);
      },
    };
  } else {
    io = options.person(sink, asked);
  }
  const registry = createPlaybookRegistry([fakedmvBooking({ origin: dmv.url })]);
  const mission = createPlaybookMission({ db: database.db, provider, registry });
  await harness.start();
  await registerTaskEngine({ db: database.db, mission, userIO: io })(harness);
  harnesses.push(harness);
  return { ledger, asked };
}

async function createTask(taskInput: BookSlotInput): Promise<Task> {
  const [task] = await database.db
    .insert(tasks)
    .values({ userId, kind: 'book_slot', input: taskInput, mode: 'playbook' })
    .returning();
  if (task === undefined) throw new Error('the task insert returned no row');
  return task;
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

async function run(worker: Worker, taskInput: BookSlotInput): Promise<TaskTimeline> {
  const task = await createTask(taskInput);
  await enqueueTaskRun(worker.ledger, task.id);
  return settled(task.id);
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

function questions(worker: Worker): string[] {
  return worker.asked.map((question) => question.question);
}

function lastTransition(timeline: TaskTimeline): TransitionEventPayload {
  const last = timeline.events
    .filter((event) => event.type === 'transition')
    .map((event) => event.payload as TransitionEventPayload)
    .at(-1);
  if (last === undefined) throw new Error('no transition on the trail');
  return last;
}

const bookings = (): Promise<Booking[]> => dmv.control.bookings();
const openSlots = async (): Promise<Slot[]> => (await dmv.control.slots()).filter((slot) => slot.status === 'open');

/** From a fresh session up to the gate. */
const TO_GATE = ['step:browser_session', 'step:availability', 'step:confirm'];
/** The task parked on the gate's question, answered, and picked up again. */
const PARKED = ['ask_user', 'transition:asked', 'user_reply', 'transition:answered', 'transition:resumed'];
/** A fresh session through to the booking. */
const BOOKED = [...TO_GATE, 'step:book'];

describe('the fakedmv booking', () => {
  it('re-checks the slot, asks before booking, and books it in a fresh session once the person says yes', async () => {
    const worker = await startWorker({ script: [{ kind: 'answer', reply: 'yes' }] });
    const taskInput = input();

    const timeline = await run(worker, taskInput);

    expect(timeline.task.status).toBe('succeeded');
    const [booking, ...rest] = await bookings();
    expect(rest).toEqual([]);
    expect(booking).toMatchObject({ slotId: TUESDAY.id, name: APPLICANT.name, reference: expect.stringMatching(REFERENCE) as string });
    // Booked means booked: the fixture's record, and its reference on the task.
    expect(parseBookSlotBooked(timeline.task.result)).toEqual({ reference: booking?.reference, bookedAt: booking?.bookedAt });
    expect(timeline.task.result).toMatchObject({ playbook: 'fakedmv.book_slot', reference: booking?.reference });
    expect(timeline.task.playbookId).toBe('fakedmv.book_slot');
    expect(await openSlots()).toEqual([]);
    expect(questions(worker)).toEqual([confirmQuestion(taskInput)]);
    expect(trail(timeline)).toEqual(['transition:started', ...TO_GATE, ...PARKED, ...BOOKED, 'transition:succeeded']);
    expect(steps(timeline, 'availability').map((step) => step.outcome)).toEqual(['done', 'done']);
    expect(steps(timeline, 'confirm')).toEqual([
      { name: 'confirm', outcome: 'ask', detail: { question: confirmQuestion(taskInput) } },
      { name: 'confirm', outcome: 'done', detail: { confirmed: 'person' } },
    ]);
    expect(steps(timeline, 'book')).toEqual([
      { name: 'book', outcome: 'done', detail: { reference: booking?.reference, slotId: TUESDAY.id, bookedAt: booking?.bookedAt } },
    ]);
    // Two sessions: one released at the gate, one that booked.
    expect(steps(timeline, 'browser_session')).toHaveLength(2);
  });

  it('books without asking when the watch said auto_book', async () => {
    const worker = await startWorker();

    const timeline = await run(worker, input(true));

    expect(timeline.task.status).toBe('succeeded');
    expect(questions(worker)).toEqual([]);
    expect(trail(timeline)).toEqual(['transition:started', ...BOOKED, 'transition:succeeded']);
    expect(steps(timeline, 'confirm')).toEqual([{ name: 'confirm', outcome: 'done', detail: { confirmed: 'auto' } }]);
    expect(await bookings()).toHaveLength(1);
    expect(parseBookSlotBooked(timeline.task.result)?.reference).toMatch(REFERENCE);
  });

  it('cancels the task when the person declines at the gate, and the slot stays open', async () => {
    const worker = await startWorker({ script: [{ kind: 'decline' }] });
    const taskInput = input();

    const timeline = await run(worker, taskInput);

    expect(timeline.task.status).toBe('cancelled');
    expect(trail(timeline)).toEqual(['transition:started', ...TO_GATE, 'ask_user', 'transition:asked', 'transition:declined']);
    expect(questions(worker)).toEqual([confirmQuestion(taskInput)]);
    expect(await bookings()).toEqual([]);
    expect(await openSlots()).toMatchObject([{ id: TUESDAY.id, status: 'open' }]);
  });

  it('ends refused, not booked, when the person answers no, and the slot stays open', async () => {
    const worker = await startWorker({ script: [{ kind: 'answer', reply: 'No thanks' }] });

    const timeline = await run(worker, input());

    expect(timeline.task.status).toBe('failed');
    expect(trail(timeline)).toEqual(['transition:started', ...TO_GATE, ...PARKED, ...TO_GATE, 'transition:refused']);
    const last = lastTransition(timeline);
    expect(last).toMatchObject({
      cause: 'refused',
      detail: { reason: `confirm: the person did not confirm booking ${TUESDAY.label}`, detail: { code: 'not-confirmed' } },
    });
    expect(bookSlotRefusal(last.detail)).toBe('not-confirmed');
    expect(await bookings()).toEqual([]);
    expect(await openSlots()).toMatchObject([{ id: TUESDAY.id, status: 'open' }]);
  });

  it('ends refused as slot-gone when the slot is not offered at the re-check, and touches nothing', async () => {
    await dmv.control.withdrawSlot(TUESDAY.id);
    const worker = await startWorker();

    const timeline = await run(worker, input(true));

    expect(timeline.task.status).toBe('failed');
    expect(trail(timeline)).toEqual(['transition:started', 'step:browser_session', 'step:availability', 'transition:refused']);
    const last = lastTransition(timeline);
    expect(last).toMatchObject({
      cause: 'refused',
      detail: { reason: `availability: fakedmv no longer offers ${TUESDAY.label}`, detail: { code: 'slot-gone' } },
    });
    expect(bookSlotRefusal(last.detail)).toBe('slot-gone');
    expect(questions(worker)).toEqual([]);
    expect(await dmv.control.state()).toMatchObject({ slots: [], bookings: [] });
  });

  it("ends refused as slot-gone when the slot is yanked between the person's yes and the booking", async () => {
    const worker = await startWorker({
      person: (sink, asked) => ({
        async ask(question) {
          asked.push(question);
          // The person takes their time; the slot does not.
          await dmv.control.withdrawSlot(TUESDAY.id);
          await sink.resolve(question.taskId, question.questionId, { kind: 'answer', reply: 'yes' });
        },
      }),
    });
    const taskInput = input();

    const timeline = await run(worker, taskInput);

    expect(timeline.task.status).toBe('failed');
    expect(trail(timeline)).toEqual([
      'transition:started',
      ...TO_GATE,
      ...PARKED,
      'step:browser_session',
      'step:availability',
      'transition:refused',
    ]);
    expect(bookSlotRefusal(lastTransition(timeline).detail)).toBe('slot-gone');
    expect(questions(worker)).toEqual([confirmQuestion(taskInput)]);
    expect(await bookings()).toEqual([]);
  });

  it('fails, and is not a refusal, when the site cannot take the booking right now; the slot stays open', async () => {
    await dmv.control.setFailureMode('transient');
    const worker = await startWorker();

    const timeline = await run(worker, input(true));

    expect(timeline.task.status).toBe('failed');
    expect(trail(timeline)).toEqual(['transition:started', ...BOOKED, 'transition:error']);
    const last = lastTransition(timeline);
    expect(last).toMatchObject({
      cause: 'error',
      detail: { reason: 'book: fakedmv could not take the booking right now (transient)' },
    });
    expect(bookSlotRefusal(last.detail)).toBeUndefined();
    expect(await bookings()).toEqual([]);
    expect(await openSlots()).toMatchObject([{ id: TUESDAY.id, status: 'open' }]);
  });

  describe('under the redesigned calendar', () => {
    // The fixture's `redesign` rotates every class, id and nesting and keeps
    // the semantic surface - visible text, accessible names, data-testid
    // hooks - byte-identical (hostile-mode-surfaces). The booking arm reads
    // that surface, so a redesign is not a reason to lose a slot.
    it('books the slot, with the record in the fixture and the reference on the task', async () => {
      await dmv.control.setMode('redesign');
      const worker = await startWorker();

      const timeline = await run(worker, input(true));

      expect(timeline.task.status, JSON.stringify(lastTransition(timeline))).toBe('succeeded');
      const [booking, ...rest] = await bookings();
      expect(rest).toEqual([]);
      expect(booking).toMatchObject({ slotId: TUESDAY.id, name: APPLICANT.name, reference: expect.stringMatching(REFERENCE) as string });
      expect(parseBookSlotBooked(timeline.task.result)).toEqual({ reference: booking?.reference, bookedAt: booking?.bookedAt });
      expect(trail(timeline)).toEqual(['transition:started', ...BOOKED, 'transition:succeeded']);
      expect(await openSlots()).toEqual([]);
    });

    it('reads a slot that is not offered as slot-gone, the same refusal as on the normal calendar', async () => {
      await dmv.control.setMode('redesign');
      await dmv.control.withdrawSlot(TUESDAY.id);
      const worker = await startWorker();

      const timeline = await run(worker, input(true));

      expect(timeline.task.status).toBe('failed');
      const last = lastTransition(timeline);
      expect(last).toMatchObject({
        cause: 'refused',
        detail: { reason: `availability: fakedmv no longer offers ${TUESDAY.label}`, detail: { code: 'slot-gone' } },
      });
      expect(bookSlotRefusal(last.detail)).toBe('slot-gone');
      expect(await dmv.control.state()).toMatchObject({ mode: 'redesign', slots: [], bookings: [] });
    });
  });
});
