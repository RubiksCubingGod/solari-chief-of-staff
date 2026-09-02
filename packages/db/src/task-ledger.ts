import { randomUUID } from 'node:crypto';

import {
  isTerminalTaskStatus,
  transitionTarget,
  type AskUserEventPayload,
  type RejectedEventPayload,
  type RejectionReason,
  type StepEventPayload,
  type TaskEventType,
  type TaskStatus,
  type TransitionCause,
  type TransitionEventPayload,
  type UserReplyEventPayload,
  type UserResolutionOutcome,
} from '@chief-of-staff/core';
import { asc, eq } from 'drizzle-orm';
import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import type { JobHarness } from './jobs.js';
import { taskEvents, tasks, type Task, type TaskEvent } from './schema.js';

/**
 * The task ledger: every way a task's status is allowed to change, and the
 * rule that none of them happens without a `task_events` row saying so.
 *
 * The database is the only task state (task-state-machine spec). A worker
 * holds nothing a crash could lose: it claims a run by writing a transition,
 * parks a question by writing it, and resumes by reading the answers back.
 * Every write here locks the task row first and checks the status it found
 * against the transition table, so two workers, a late answer, and a stale
 * timer all serialise on the row and the one that loses records a `rejected`
 * event rather than overwriting the one that won.
 */

/** Both the shared client and a transaction inside it. */
export type TaskDatabase = PgDatabase<NodePgQueryResultHKT, Record<string, never>>;

/** The queue a task's run travels on. The payload is only the id: the row is the state. */
export const TASK_RUN_QUEUE = 'tasks.run';
/** The queue a question's deadline travels on, held until the deadline. */
export const TASK_TIMEOUT_QUEUE = 'tasks.timeout';

export interface TaskRunJob {
  readonly taskId: string;
}

export interface TaskTimeoutJob {
  readonly taskId: string;
  readonly questionId: string;
}

/** What the ledger needs to enqueue as well as write. */
export interface TaskLedger {
  readonly db: TaskDatabase;
  readonly harness: JobHarness;
}

export interface TaskTimeline {
  readonly task: Task;
  /** Oldest first. */
  readonly events: readonly TaskEvent[];
}

/** A question and the reply the ledger accepted for it. */
export interface TaskAnswer {
  readonly questionId: string;
  readonly question: string;
  readonly reply: string;
  readonly answeredAt: string;
}

async function eventsOf(db: TaskDatabase, taskId: string): Promise<TaskEvent[]> {
  return db
    .select()
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    .orderBy(asc(taskEvents.seq));
}

export async function readTaskTimeline(
  db: TaskDatabase,
  taskId: string,
): Promise<TaskTimeline | undefined> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (task === undefined) return undefined;
  return { task, events: await eventsOf(db, taskId) };
}

function lastQuestion(events: readonly TaskEvent[]): AskUserEventPayload | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'ask_user') return event.payload as AskUserEventPayload;
  }
  return undefined;
}

/** The question a parked task is waiting on, or nothing when it is not parked. */
export function pendingQuestion(timeline: TaskTimeline): AskUserEventPayload | undefined {
  return timeline.task.status === 'waiting_user' ? lastQuestion(timeline.events) : undefined;
}

/** Every answer the ledger accepted, oldest first, each with the question it answered. */
export function acceptedAnswers(events: readonly TaskEvent[]): TaskAnswer[] {
  const questions = new Map<string, AskUserEventPayload>();
  const answers: TaskAnswer[] = [];
  for (const event of events) {
    if (event.type === 'ask_user') {
      const question = event.payload as AskUserEventPayload;
      questions.set(question.questionId, question);
    } else if (event.type === 'user_reply') {
      const reply = event.payload as UserReplyEventPayload;
      const question = questions.get(reply.questionId);
      if (question === undefined) continue;
      answers.push({
        questionId: reply.questionId,
        question: question.question,
        reply: reply.reply,
        answeredAt: reply.answeredAt,
      });
    }
  }
  return answers;
}

async function appendWithin(
  db: TaskDatabase,
  taskId: string,
  type: TaskEventType,
  payload: unknown,
): Promise<TaskEvent> {
  const [event] = await db
    .insert(taskEvents)
    .values({ taskId, ts: new Date(), type, payload })
    .returning();
  if (event === undefined) throw new Error(`task ${taskId}: the event insert returned no row`);
  return event;
}

/** Appends an event outside any transition - a mission's `step`, typically. */
export function appendTaskEvent(
  db: TaskDatabase,
  taskId: string,
  type: TaskEventType,
  payload: unknown,
): Promise<TaskEvent> {
  return appendWithin(db, taskId, type, payload);
}

/** The row, locked for the rest of the transaction. */
async function lockTask(tx: TaskDatabase, taskId: string): Promise<Task | undefined> {
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('update');
  return task;
}

interface TransitionColumns {
  readonly result?: unknown;
  readonly jobId?: string;
}

/**
 * Moves a locked task by `cause`, which the caller has already checked is
 * allowed from where the task is, and writes the transition event in the same
 * transaction.
 */
async function moveWithin(
  tx: TaskDatabase,
  task: Task,
  cause: TransitionCause,
  detail: unknown,
  columns: TransitionColumns = {},
): Promise<Task> {
  const to = transitionTarget(task.status, cause);
  if (to === undefined) {
    throw new Error(`task ${task.id}: '${cause}' is not allowed from '${task.status}'`);
  }
  const [moved] = await tx
    .update(tasks)
    .set({
      status: to,
      ...(isTerminalTaskStatus(to) ? { finishedAt: new Date() } : {}),
      ...(columns.result === undefined ? {} : { result: columns.result }),
      ...(columns.jobId === undefined ? {} : { jobId: columns.jobId }),
    })
    .where(eq(tasks.id, task.id))
    .returning();
  if (moved === undefined) throw new Error(`task ${task.id}: the update returned no row`);
  const payload: TransitionEventPayload = { from: task.status, to, cause, detail: detail ?? null };
  await appendWithin(tx, task.id, 'transition', payload);
  return moved;
}

async function rejectWithin(
  tx: TaskDatabase,
  task: Task,
  attempted: TransitionCause,
  reason: RejectionReason,
  detail: unknown,
): Promise<void> {
  const payload: RejectedEventPayload = {
    attempted,
    status: task.status,
    reason,
    detail: detail ?? null,
  };
  await appendWithin(tx, task.id, 'rejected', payload);
}

export interface TransitionRequest {
  readonly cause: TransitionCause;
  readonly detail?: unknown;
  /** Written with a terminal transition; the row's `result` is otherwise left alone. */
  readonly result?: unknown;
}

export type TransitionOutcome =
  | { readonly ok: true; readonly task: Task }
  /** Refused and recorded; `status` is what the task still is, or undefined for no such task. */
  | { readonly ok: false; readonly status: TaskStatus | undefined };

/**
 * One transition, or one `rejected` event. The row never changes on
 * refusal, which is what makes every transition idempotent: asking twice for
 * the same move records the second as illegal from the status the first
 * reached.
 */
export function transitionTask(
  db: TaskDatabase,
  taskId: string,
  request: TransitionRequest,
): Promise<TransitionOutcome> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    if (task === undefined) return { ok: false, status: undefined };
    if (transitionTarget(task.status, request.cause) === undefined) {
      await rejectWithin(tx, task, request.cause, 'illegal', request.detail);
      return { ok: false, status: task.status };
    }
    const columns = request.result === undefined ? {} : { result: request.result };
    return { ok: true, task: await moveWithin(tx, task, request.cause, request.detail, columns) };
  });
}

export type EnqueueOutcome =
  | { readonly enqueued: true; readonly jobId: string }
  /** Nothing enqueued: the task is not queued, or does not exist. */
  | { readonly enqueued: false; readonly status: TaskStatus | undefined };

/**
 * Sends the run job for a queued task and records the job on the row. Only a
 * queued task gets a job: enqueuing a running one would hand a second worker
 * a task the first is still inside. The row lock covers the send, so a
 * delivery that arrives before this commits waits, then finds the job id.
 */
export function enqueueTaskRun(ledger: TaskLedger, taskId: string): Promise<EnqueueOutcome> {
  return ledger.db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    if (task === undefined) return { enqueued: false, status: undefined };
    if (task.status !== 'queued') return { enqueued: false, status: task.status };
    const job: TaskRunJob = { taskId };
    const jobId = await ledger.harness.enqueue(TASK_RUN_QUEUE, job);
    await tx.update(tasks).set({ jobId }).where(eq(tasks.id, taskId));
    return { enqueued: true, jobId };
  });
}

export type ClaimOutcome =
  /** The worker owns the run: the task is running and these are its answers so far. */
  | { readonly kind: 'run'; readonly task: Task; readonly answers: readonly TaskAnswer[] }
  /** Another job owns this task; this delivery is a duplicate and does nothing. */
  | { readonly kind: 'stale' }
  /** The task is not runnable from where it is - parked, finished, or gone. */
  | { readonly kind: 'settled'; readonly status: TaskStatus | undefined };

/**
 * A worker's first write on delivery. Delivered once, a queued task starts;
 * delivered again after the last worker died, a running task is retried;
 * delivered again for any other reason - the job id no longer on the row, or
 * the task already past running - nothing happens, which is what makes
 * at-least-once delivery safe.
 */
export function claimTaskRun(
  db: TaskDatabase,
  taskId: string,
  jobId: string,
): Promise<ClaimOutcome> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    if (task === undefined) return { kind: 'settled', status: undefined };
    if (task.jobId !== null && task.jobId !== jobId) return { kind: 'stale' };
    const answers = acceptedAnswers(await eventsOf(tx, taskId));
    if (task.status === 'queued') {
      const cause = answers.length > 0 ? 'resumed' : 'started';
      return { kind: 'run', task: await moveWithin(tx, task, cause, { jobId }, { jobId }), answers };
    }
    if (task.status === 'running') {
      return { kind: 'run', task: await moveWithin(tx, task, 'retried', { jobId }), answers };
    }
    return { kind: 'settled', status: task.status };
  });
}

export interface AskRequest {
  readonly question: string;
  readonly expiresAt: Date;
}

export type AskOutcome =
  | { readonly ok: true; readonly question: AskUserEventPayload }
  | { readonly ok: false; readonly status: TaskStatus | undefined };

/**
 * Parks a running task on a question. The question and the transition commit
 * together; the deadline is then a held job, so it fires in whichever worker
 * is alive when it falls due rather than in the one that asked.
 */
export async function askUser(
  ledger: TaskLedger,
  taskId: string,
  request: AskRequest,
): Promise<AskOutcome> {
  const outcome = await ledger.db.transaction(async (tx): Promise<AskOutcome> => {
    const task = await lockTask(tx, taskId);
    if (task === undefined) return { ok: false, status: undefined };
    if (transitionTarget(task.status, 'asked') === undefined) {
      await rejectWithin(tx, task, 'asked', 'illegal', { question: request.question });
      return { ok: false, status: task.status };
    }
    const question: AskUserEventPayload = {
      questionId: randomUUID(),
      question: request.question,
      askedAt: new Date().toISOString(),
      expiresAt: request.expiresAt.toISOString(),
    };
    await appendWithin(tx, taskId, 'ask_user', question);
    await moveWithin(tx, task, 'asked', { questionId: question.questionId });
    return { ok: true, question };
  });
  if (outcome.ok) {
    const job: TaskTimeoutJob = { taskId, questionId: outcome.question.questionId };
    await ledger.harness.enqueue(TASK_TIMEOUT_QUEUE, job, { startAfter: request.expiresAt });
  }
  return outcome;
}

export interface TaskReply {
  readonly questionId: string;
  readonly reply: string;
}

/** What became of an answer or a decline: the port's own outcome type, so a channel sees one shape. */
export type AnswerOutcome = UserResolutionOutcome;

type Refusal = Extract<AnswerOutcome, { readonly accepted: false }>;

/**
 * The checks an answer and a decline share, under the caller's row lock: the
 * task is parked, it is parked on this question, and the deadline has not
 * passed. Each failure is recorded as a `rejected` event naming what was
 * attempted. The last check also expires the question on the spot: the person
 * was late, and the trail should say the deadline passed before it says they
 * tried.
 */
async function openQuestion(
  tx: TaskDatabase,
  task: Task,
  questionId: string,
  attempted: 'answered' | 'declined',
  detail: unknown,
  now: Date,
): Promise<AskUserEventPayload | Refusal> {
  if (task.status !== 'waiting_user') {
    await rejectWithin(tx, task, attempted, 'not_waiting', detail);
    return { accepted: false, reason: 'not_waiting' };
  }
  const question = lastQuestion(await eventsOf(tx, task.id));
  if (question === undefined || question.questionId !== questionId) {
    await rejectWithin(tx, task, attempted, 'unknown_question', detail);
    return { accepted: false, reason: 'unknown_question' };
  }
  if (Date.parse(question.expiresAt) <= now.getTime()) {
    const failed = await moveWithin(tx, task, 'timeout', {
      questionId: question.questionId,
      expiresAt: question.expiresAt,
    });
    await rejectWithin(tx, failed, attempted, 'expired', detail);
    return { accepted: false, reason: 'expired' };
  }
  return question;
}

/**
 * Accepts an answer to the question a task is parked on and queues the task
 * to run again. Anything else - a task not waiting, a question that is not
 * the pending one, an answer past the deadline - is refused and recorded.
 */
export async function answerTask(
  ledger: TaskLedger,
  taskId: string,
  reply: TaskReply,
  now: Date = new Date(),
): Promise<AnswerOutcome> {
  const outcome = await ledger.db.transaction(async (tx): Promise<AnswerOutcome> => {
    const task = await lockTask(tx, taskId);
    if (task === undefined) return { accepted: false, reason: 'not_found' };
    const detail = { questionId: reply.questionId, reply: reply.reply };
    const question = await openQuestion(tx, task, reply.questionId, 'answered', detail, now);
    if ('accepted' in question) return question;
    const accepted: UserReplyEventPayload = {
      questionId: question.questionId,
      reply: reply.reply,
      answeredAt: now.toISOString(),
    };
    await appendWithin(tx, taskId, 'user_reply', accepted);
    await moveWithin(tx, task, 'answered', { questionId: question.questionId });
    return { accepted: true };
  });
  // Outside the transaction: the answer is on the record whether or not the
  // send succeeds, and a queued task nobody enqueued is what the reconcile
  // sweep exists to pick up.
  if (outcome.accepted) await enqueueTaskRun(ledger, taskId);
  return outcome;
}

export interface TaskDecline {
  readonly questionId: string;
}

/**
 * Cancels a task on the person's say-so. A decline is a transition, not an
 * answer: nothing is written for a mission to read back, because no mission
 * runs again. The same checks as an answer apply and the same refusals are
 * recorded, so a decline for the wrong question, or after the deadline, is
 * turned away rather than cancelling something the person did not mean.
 */
export function declineTask(
  db: TaskDatabase,
  taskId: string,
  decline: TaskDecline,
  now: Date = new Date(),
): Promise<AnswerOutcome> {
  return db.transaction(async (tx): Promise<AnswerOutcome> => {
    const task = await lockTask(tx, taskId);
    if (task === undefined) return { accepted: false, reason: 'not_found' };
    const detail = { questionId: decline.questionId };
    const question = await openQuestion(tx, task, decline.questionId, 'declined', detail, now);
    if ('accepted' in question) return question;
    await moveWithin(tx, task, 'declined', { questionId: question.questionId });
    return { accepted: true };
  });
}

/**
 * Fails a task still parked on `questionId`. True when it did; false when the
 * question was answered, replaced, or never there - a stale timer, which is
 * not an attempt at anything and so leaves no `rejected` row.
 */
export function expireQuestion(
  db: TaskDatabase,
  taskId: string,
  questionId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    if (task === undefined || task.status !== 'waiting_user') return false;
    const question = lastQuestion(await eventsOf(tx, taskId));
    if (question === undefined || question.questionId !== questionId) return false;
    await moveWithin(tx, task, 'timeout', { questionId, expiresAt: question.expiresAt });
    return true;
  });
}

/**
 * Fails a running task whose job pg-boss has given up on. True when it did;
 * false when the task moved on or a different job owns it now, in which case
 * the sweep was looking at a stale row and there is nothing to record.
 */
export function orphanTask(
  db: TaskDatabase,
  taskId: string,
  jobId: string | null,
  jobState: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    if (task === undefined || task.status !== 'running' || task.jobId !== jobId) return false;
    await moveWithin(tx, task, 'orphaned', { jobId, jobState });
    return true;
  });
}

/** Which browser session a run used, and whether the provider recorded it. */
export interface BrowserSessionRecord {
  readonly provider: string;
  readonly sessionId: string;
  /** What the provider echoed. `false` is an honest absence - the local provider never records - not an error. */
  readonly recording: boolean;
  readonly recordingUrl?: string;
}

/**
 * Puts the session on the task's row - the columns the dashboard's replay
 * reads - and a `step` on the trail, so the timeline says which session ran
 * and whether anyone will be able to watch it. Written as soon as a session
 * is acquired; a later session on the same task replaces the columns and
 * adds another step.
 */
export async function recordBrowserSession(
  db: TaskDatabase,
  taskId: string,
  record: BrowserSessionRecord,
): Promise<void> {
  await db
    .update(tasks)
    .set({ solariSessionId: record.sessionId, recordingUrl: record.recordingUrl ?? null })
    .where(eq(tasks.id, taskId));
  const payload: StepEventPayload = {
    name: 'browser_session',
    outcome: record.recording ? 'recorded' : 'unrecorded',
    detail: {
      provider: record.provider,
      sessionId: record.sessionId,
      recording: record.recording,
      recordingUrl: record.recordingUrl ?? null,
    },
  };
  await appendWithin(db, taskId, 'step', payload);
}

/**
 * Writes which playbook a task went to. Written as soon as the playbook is
 * chosen, before the connection is read, so a task refused after that still
 * says which playbook refused it.
 */
export async function recordPlaybook(db: TaskDatabase, taskId: string, playbookId: string): Promise<void> {
  await db.update(tasks).set({ playbookId }).where(eq(tasks.id, taskId));
}
