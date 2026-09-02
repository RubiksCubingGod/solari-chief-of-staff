import type { UserAnswerSink, UserIO } from '@chief-of-staff/core';

import { answerTask, declineTask, type TaskLedger } from './task-ledger.js';

/**
 * The answer sink over a ledger: what a channel calls once a person has
 * spoken. An answer queues the task to run again with it; a decline cancels
 * the task; either one arriving late, or for a question the task is not
 * parked on, is refused and recorded rather than applied.
 */
export function createUserAnswerSink(
  ledger: TaskLedger,
  now: () => Date = () => new Date(),
): UserAnswerSink {
  return {
    resolve: (taskId, questionId, resolution) =>
      resolution.kind === 'answer'
        ? answerTask(ledger, taskId, { questionId, reply: resolution.reply }, now())
        : declineTask(ledger.db, taskId, { questionId }, now()),
  };
}

/** Where a question's line goes. */
export type QuestionLogSink = (line: string) => void;

/**
 * The way out until a delivery channel lands: every question is one JSON
 * line on stdout, the way the watch engine's events are, with the kind first
 * so a reader can pick them out. Nothing is lost by it: the question is on
 * the task's row before this is called, and the answer sink takes the reply
 * from wherever a person eventually gives it.
 */
export function createLogUserIO(
  write: QuestionLogSink = (line) => {
    process.stdout.write(`${line}\n`);
  },
): UserIO {
  return {
    ask: (question) => {
      write(JSON.stringify({ kind: 'ask_user', ...question }));
      return Promise.resolve();
    },
  };
}
