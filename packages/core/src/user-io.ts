/**
 * The ask-a-human port (task-state-machine spec: the waiting_user gate).
 *
 * The engine parks a task by writing the question; something then has to put
 * that question in front of a person and carry what they say back. This is
 * that something's shape and nothing more: one way out (`UserIO.ask`) and one
 * way back in (`UserAnswerSink.resolve`). The sink is the ledger's answer
 * path; the port is whatever reaches the person - a scripted double in this
 * sprint's proofs, Telegram in s7. Neither side holds state, so a worker that
 * dies between the ask and the answer loses nothing the row does not have.
 */

import type { AskUserEventPayload, RejectionReason } from './task-lifecycle.js';

/** A question on its way to a person: what the ledger recorded, and whose task it is. */
export interface UserQuestion extends AskUserEventPayload {
  readonly taskId: string;
  readonly userId: string;
}

/** What a person can say back: an answer to go on with, or a refusal to go on at all. */
export type UserResolution =
  | { readonly kind: 'answer'; readonly reply: string }
  | { readonly kind: 'decline' };

/**
 * What became of what the person said. A refusal is also on the trail as a
 * `rejected` event; `not_found` is the one case with no trail to put it on.
 */
export type UserResolutionOutcome =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly reason: Exclude<RejectionReason, 'illegal'> | 'not_found';
    };

/** The way out: puts a question in front of the person the task belongs to. */
export interface UserIO {
  /**
   * Resolves once the question has been handed over; rejects when it could
   * not be. The task is already parked when this is called, so a failure
   * here loses the delivery, never the question.
   */
  ask(question: UserQuestion): Promise<void>;
}

/** The way back in: carries what the person said to the task's ledger. */
export interface UserAnswerSink {
  resolve(
    taskId: string,
    questionId: string,
    resolution: UserResolution,
  ): Promise<UserResolutionOutcome>;
}

/** A line of the script: what to say to the nth question, or `ignore` to leave it unanswered. */
export type ScriptedReply = UserResolution | { readonly kind: 'ignore' };

export interface ScriptedUserIOOptions {
  /** How long after the ask the reply reaches the sink. Zero by default: promptly, but after `ask` has returned. */
  readonly delayMs?: number;
}

export interface ScriptedUserIO extends UserIO {
  /** Every question asked so far, oldest first. */
  readonly asked: readonly UserQuestion[];
  /** What the sink said to each reply the script delivered, in the order the sink answered. */
  readonly outcomes: readonly UserResolutionOutcome[];
  /** Resolves once every reply the script owed has reached the sink. */
  settled(): Promise<void>;
}

/**
 * A person played from a script: the nth question gets the nth line. Questions
 * past the end of the script are ignored, like a person who stopped reading -
 * which is how a proof reaches the timeout path on purpose. Replies always
 * land after `ask` has returned, the way a real person's would.
 */
export function scriptedUserIO(
  sink: UserAnswerSink,
  script: readonly ScriptedReply[],
  options: ScriptedUserIOOptions = {},
): ScriptedUserIO {
  const asked: UserQuestion[] = [];
  const outcomes: UserResolutionOutcome[] = [];
  const pending: Promise<void>[] = [];
  const delayMs = options.delayMs ?? 0;
  return {
    asked,
    outcomes,
    ask(question) {
      const line = script[asked.length];
      asked.push(question);
      if (line === undefined || line.kind === 'ignore') return Promise.resolve();
      pending.push(
        new Promise<void>((resolve) => setTimeout(resolve, delayMs))
          .then(() => sink.resolve(question.taskId, question.questionId, line))
          .then((outcome) => {
            outcomes.push(outcome);
          }),
      );
      return Promise.resolve();
    },
    async settled() {
      await Promise.all(pending);
    },
  };
}
