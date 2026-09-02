import type { UserAnswerSink } from '@chief-of-staff/core';

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
