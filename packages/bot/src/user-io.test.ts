import type { UserQuestion } from '@chief-of-staff/core';
import type { Delivery } from '@chief-of-staff/db';
import { describe, expect, it } from 'vitest';

import { NoBindingError, type SendToUser } from './outbound.js';
import { createTelegramUserIO } from './user-io.js';

/**
 * The question port over a stand-in door: what the engine is told about a
 * question that went, one that did not, and one with nobody to go to. The
 * real door has its own proofs; this is about the one promise the port
 * makes, which is never to say "asked" about a question nobody received.
 */

const QUESTION: UserQuestion = {
  taskId: 'task-1',
  userId: 'user-1',
  questionId: 'question-1',
  question: 'Cancel Gym before it renews on 2026-09-12? Reply yes to go ahead, or no to leave it as it is.',
  askedAt: '2026-09-09T12:00:00Z',
  expiresAt: '2026-09-10T12:00:00Z',
};

function settled(status: Delivery['status'], error: string | null = null): Delivery {
  return {
    id: 'delivery-1',
    userId: QUESTION.userId,
    chatId: '80001',
    text: QUESTION.question,
    status,
    attempts: 1,
    error,
    createdAt: new Date('2026-09-09T12:00:00Z'),
    settledAt: new Date('2026-09-09T12:00:01Z'),
    dedupKey: null,
  };
}

/** A door that records what it was asked to send and answers with the row given. */
function door(answer: Delivery | Error): SendToUser & { readonly sent: [string, string][] } {
  const sent: [string, string][] = [];
  const send: SendToUser = (userId, text) => {
    sent.push([userId, text]);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  return Object.assign(send, { sent });
}

describe('createTelegramUserIO', () => {
  it('sends the question to its person, as the words the engine wrote', async () => {
    const send = door(settled('sent'));

    await expect(createTelegramUserIO(send).ask(QUESTION)).resolves.toBeUndefined();

    expect(send.sent).toEqual([[QUESTION.userId, QUESTION.question]]);
  });

  it('throws when the door gave up, with the words the door left', async () => {
    const send = door(settled('failed', 'Telegram answered 500 three times'));

    await expect(createTelegramUserIO(send).ask(QUESTION)).rejects.toThrow(
      'the question was not delivered: Telegram answered 500 three times',
    );
  });

  it('names the state when a delivery ended with no words at all', async () => {
    const send = door(settled('pending'));

    await expect(createTelegramUserIO(send).ask(QUESTION)).rejects.toThrow(
      'the question was not delivered: pending',
    );
  });

  it('lets the door say there is nobody to send to', async () => {
    const send = door(new NoBindingError(QUESTION.userId));

    // The door's own error, through: the trail then says which of the two
    // ways of not arriving this was, and the operator knows which to fix.
    await expect(createTelegramUserIO(send).ask(QUESTION)).rejects.toBeInstanceOf(NoBindingError);
  });
});
