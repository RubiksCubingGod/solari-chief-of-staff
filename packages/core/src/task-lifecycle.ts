/**
 * The task state machine's rules (ARCHITECTURE §3.2), with nothing persisted.
 *
 * `@chief-of-staff/db` owns the rows and pg-boss owns the retries. What lives
 * here is the one question the ledger, the API, and the dashboard all have to
 * answer the same way: from this status, does this cause lead anywhere, and
 * where? A transition that is not in this table does not happen; the ledger
 * records the attempt as a `rejected` event instead, so a bug that asks for
 * the impossible leaves evidence rather than a corrupted row.
 */

import type { TaskStatus } from './index.js';

/** Statuses a task never leaves. `finished_at` is set exactly when one is reached. */
export const TERMINAL_TASK_STATUSES = [
  'succeeded',
  'failed',
  'cancelled',
] as const satisfies readonly TaskStatus[];
export type TerminalTaskStatus = (typeof TERMINAL_TASK_STATUSES)[number];

const terminal: ReadonlySet<string> = new Set(TERMINAL_TASK_STATUSES);

export function isTerminalTaskStatus(status: TaskStatus): status is TerminalTaskStatus {
  return terminal.has(status);
}

/**
 * Why a task moved. Every `transition` event names one of these, which is what
 * makes the trail answer "what happened" rather than merely "what changed":
 * `failed` alone says nothing, `failed` by `timeout` says a person did not
 * answer in time.
 */
export const TRANSITION_CAUSES = [
  /** A worker picked the queued task up for the first time. */
  'started',
  /** A worker picked it up again after an answer re-queued it. */
  'resumed',
  /** pg-boss handed the same job to a worker again after the last one died mid-run. */
  'retried',
  /** The mission needs a person before it can go on. */
  'asked',
  /** The person answered, and the task is queued to run again with the answer. */
  'answered',
  /** The mission finished what it was asked to do. */
  'succeeded',
  /** The mission failed on its own terms, or threw. */
  'error',
  /** A guardrail stopped the mission: it left its lane, or tried to pay. */
  'violation',
  /** Nobody answered the question before its deadline. */
  'timeout',
  /** The worker died and pg-boss has no retry left to give the job. */
  'orphaned',
  /** The person declined the question, and with it the task. */
  'declined',
] as const;
export type TransitionCause = (typeof TRANSITION_CAUSES)[number];

export interface TaskTransition {
  /** The statuses this cause is allowed to move a task out of. */
  readonly from: readonly TaskStatus[];
  readonly to: TaskStatus;
}

/**
 * The whole machine. `retried` is the one self-transition: a task whose worker
 * died is still `running` on the row, and the retry is recorded as a move so
 * the trail shows the crash happened rather than hiding it inside a longer
 * `running` span.
 */
export const TASK_TRANSITIONS: Readonly<Record<TransitionCause, TaskTransition>> = {
  started: { from: ['queued'], to: 'running' },
  resumed: { from: ['queued'], to: 'running' },
  retried: { from: ['running'], to: 'running' },
  asked: { from: ['running'], to: 'waiting_user' },
  answered: { from: ['waiting_user'], to: 'queued' },
  succeeded: { from: ['running'], to: 'succeeded' },
  error: { from: ['running'], to: 'failed' },
  violation: { from: ['running'], to: 'failed' },
  timeout: { from: ['waiting_user'], to: 'failed' },
  orphaned: { from: ['running'], to: 'failed' },
  declined: { from: ['waiting_user'], to: 'cancelled' },
};

/** Where `cause` takes a task in `status`, or nowhere when the table does not allow it. */
export function transitionTarget(status: TaskStatus, cause: TransitionCause): TaskStatus | undefined {
  const rule = TASK_TRANSITIONS[cause];
  return rule.from.includes(status) ? rule.to : undefined;
}

/** Why the ledger refused something. */
export const REJECTION_REASONS = [
  /** The transition table has no row for this status and cause. */
  'illegal',
  /** An answer arrived for a task that is not parked on a question. */
  'not_waiting',
  /** An answer named a question that is not the one the task is parked on. */
  'unknown_question',
  /** An answer arrived after the question's deadline. */
  'expired',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

/*
 * The payload of each `task_events` type. Declared here rather than beside the
 * table because the dashboard renders them and may not import the schema.
 */

/** `transition`: the row moved, and why. */
export interface TransitionEventPayload {
  readonly from: TaskStatus;
  readonly to: TaskStatus;
  readonly cause: TransitionCause;
  /** Whatever the cause has to say for itself: a job id, an error, a question id. Null when nothing. */
  readonly detail: unknown;
}

/** `ask_user`: the question the task is parked on, with its deadline. */
export interface AskUserEventPayload {
  readonly questionId: string;
  readonly question: string;
  readonly askedAt: string;
  readonly expiresAt: string;
}

/** `user_reply`: an answer the ledger accepted. Refused answers are `rejected` events. */
export interface UserReplyEventPayload {
  readonly questionId: string;
  readonly reply: string;
  readonly answeredAt: string;
}

/** `rejected`: someone asked for a move the machine does not allow from where the task was. */
export interface RejectedEventPayload {
  readonly attempted: TransitionCause;
  /** The status the task was in when refused - and still is. */
  readonly status: TaskStatus;
  readonly reason: RejectionReason;
  readonly detail: unknown;
}

/** `step`: what the mission did, in its own words. */
export interface StepEventPayload {
  readonly name: string;
  readonly outcome?: string;
  readonly detail?: unknown;
}
