import type { StepEventPayload } from '@chief-of-staff/core';
import { describe, expect, it } from 'vitest';

import { withConfirmation } from './confirm.js';
import type { Task } from './schema.js';
import type { Mission, MissionContext, MissionOutcome } from './task-engine.js';
import type { TaskAnswer } from './task-ledger.js';

/**
 * The confirm gate on its own: a mission that counts whether it ran, behind a
 * task whose input does or does not carry a question, with the answers the
 * ledger would have accepted. What the trail records is asserted alongside
 * what happens, because the trail is how a person later reads why a
 * cancellation did or did not run.
 */

const QUESTION =
  'Cancel Gym before it renews on 2026-09-12? Amount: 45.00. Reply yes to go ahead, or no to leave it as it is.';
const DONE: MissionOutcome = { kind: 'succeeded', result: 'cancelled' };

/** Only the columns the gate reads; the rest of the row is not its business. */
function taskWith(input: unknown): Task {
  return { id: 'task-1', userId: 'user-1', kind: 'cancel', input, status: 'running', mode: 'playbook' } as Task;
}

function answered(...replies: readonly string[]): TaskAnswer[] {
  return replies.map((reply, index) => ({
    questionId: `question-${String(index)}`,
    question: QUESTION,
    reply,
    answeredAt: '2026-09-09T12:00:00Z',
  }));
}

interface Run {
  readonly outcome: MissionOutcome;
  readonly steps: StepEventPayload[];
  readonly ran: boolean;
}

async function run(input: unknown, answers: readonly TaskAnswer[] = []): Promise<Run> {
  const steps: StepEventPayload[] = [];
  let ran = false;
  const mission: Mission = () => {
    ran = true;
    return Promise.resolve(DONE);
  };
  const context: MissionContext = {
    task: taskWith(input),
    answers,
    step: (payload) => {
      steps.push(payload);
      return Promise.resolve();
    },
  };
  const outcome = await withConfirmation(mission)(context);
  return { outcome, steps, ran };
}

describe('withConfirmation', () => {
  it('runs a task that carries no question straight through, and writes nothing', async () => {
    expect(await run({ site: 'fakegym' })).toEqual({ outcome: DONE, steps: [], ran: true });
    expect(await run('not even an object')).toMatchObject({ outcome: DONE, ran: true });
  });

  it('asks the question before anything runs', async () => {
    const first = await run({ site: 'fakegym', confirm: QUESTION });
    expect(first).toEqual({ outcome: { kind: 'ask', question: QUESTION }, steps: [], ran: false });
  });

  it('opens on a yes, and says so on the trail with the words', async () => {
    const opened = await run({ site: 'fakegym', confirm: QUESTION }, answered('Yes, please.'));
    expect(opened.ran).toBe(true);
    expect(opened.outcome).toEqual(DONE);
    expect(opened.steps).toEqual([
      { name: 'confirm', outcome: 'confirmed', detail: { question: QUESTION, reply: 'Yes, please.' } },
    ]);
  });

  it('refuses on a no that arrived as an answer, without running', async () => {
    const refused = await run({ site: 'fakegym', confirm: QUESTION }, answered('nope'));
    expect(refused.ran).toBe(false);
    expect(refused.outcome).toEqual({
      kind: 'failed',
      cause: 'refused',
      reason: `you said no to: ${QUESTION}`,
    });
    expect(refused.steps).toEqual([
      { name: 'confirm', outcome: 'refused', detail: { question: QUESTION, reply: 'nope' } },
    ]);
  });

  it('asks again when the reply is neither, and records that it did', async () => {
    const unclear = await run({ site: 'fakegym', confirm: QUESTION }, answered('the annual one?'));
    expect(unclear.ran).toBe(false);
    expect(unclear.outcome).toEqual({ kind: 'ask', question: QUESTION });
    expect(unclear.steps).toEqual([
      { name: 'confirm', outcome: 'unclear', detail: { question: QUESTION, reply: 'the annual one?' } },
    ]);
  });

  it('reads the latest reply to the question, so a re-asked question is answered by its answer', async () => {
    expect(await run({ confirm: QUESTION }, answered('what?', 'yes'))).toMatchObject({ ran: true });
    expect(await run({ confirm: QUESTION }, answered('yes', 'no'))).toMatchObject({
      ran: false,
      outcome: { cause: 'refused' },
    });
  });

  it('is not answered by a reply to some other question', async () => {
    const other: TaskAnswer = {
      questionId: 'other',
      question: 'Which membership?',
      reply: 'yes',
      answeredAt: '2026-09-09T12:00:00Z',
    };
    expect(await run({ confirm: QUESTION }, [other])).toEqual({
      outcome: { kind: 'ask', question: QUESTION },
      steps: [],
      ran: false,
    });
  });

  it('fails rather than runs a task whose confirm is not a question', async () => {
    for (const confirm of [42, '', '   ', null, { question: QUESTION }]) {
      const broken = await run({ site: 'fakegym', confirm }, answered('yes'));
      expect(broken.ran, JSON.stringify(confirm)).toBe(false);
      expect(broken.outcome).toEqual({
        kind: 'failed',
        cause: 'error',
        reason: 'the task input carries a confirm that is not a question',
      });
    }
  });
});
