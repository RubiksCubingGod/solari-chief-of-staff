import { readConsent } from '@chief-of-staff/core';

import type { Mission, MissionContext, MissionOutcome } from './task-engine.js';
import type { TaskAnswer } from './task-ledger.js';

/**
 * The confirm gate (auto-cancel-path spec).
 *
 * A task whose input carries `confirm` - a question, as words - runs its
 * mission only behind a yes to that question. The gate is the first act of
 * every run: before a browser, before a playbook is even chosen, so a no
 * costs nothing and a task nobody answers holds nothing. It is a wrapper
 * around the mission rather than a step inside each playbook because
 * "nothing irreversible without a yes" is a promise the worker makes, not
 * one every playbook has to remember to keep; and it reads the task's own
 * input rather than the calendar, so a cancel task the chat loop queues can
 * ask the same way by carrying the same key.
 *
 * The reply comes back through a chat, as words. A plain yes opens the gate,
 * and the trail records that it did, with the words, on every run that
 * passed it. A plain no - one that reached here as an answer rather than
 * being turned into a decline by the channel - fails the task as refused.
 * Anything else is asked again: the person may have been answering
 * something else, and the action behind the question is not one to guess
 * about. Each ask has its own deadline, so an unclear person is not asked
 * forever.
 */
export function withConfirmation(mission: Mission): Mission {
  return async (context: MissionContext): Promise<MissionOutcome> => {
    const question = confirmQuestionOf(context.task.input);
    if (question === undefined) return mission(context);
    if (question === null) {
      return {
        kind: 'failed',
        cause: 'error',
        reason: 'the task input carries a confirm that is not a question',
      };
    }
    const reply = latestReply(context.answers, question);
    if (reply === undefined) return { kind: 'ask', question };
    const detail = { question, reply };
    switch (readConsent(reply)) {
      case 'yes':
        await context.step({ name: 'confirm', outcome: 'confirmed', detail });
        return mission(context);
      case 'no':
        await context.step({ name: 'confirm', outcome: 'refused', detail });
        return { kind: 'failed', cause: 'refused', reason: `you said no to: ${question}` };
      case 'unclear':
        await context.step({ name: 'confirm', outcome: 'unclear', detail });
        return { kind: 'ask', question };
    }
  };
}

/**
 * The question the input carries: `undefined` when it carries none, `null`
 * when it carries something that is not one - which is a writer's mistake,
 * and not a reason to run unconfirmed.
 */
function confirmQuestionOf(input: unknown): string | null | undefined {
  if (typeof input !== 'object' || input === null || !('confirm' in input)) return undefined;
  const confirm = (input as { readonly confirm: unknown }).confirm;
  return typeof confirm === 'string' && confirm.trim() !== '' ? confirm : null;
}

/** The newest accepted reply to exactly this question; a re-asked question is answered by its latest reply. */
function latestReply(answers: readonly TaskAnswer[], question: string): string | undefined {
  for (let index = answers.length - 1; index >= 0; index -= 1) {
    const answer = answers[index];
    if (answer !== undefined && answer.question === question) return answer.reply;
  }
  return undefined;
}
