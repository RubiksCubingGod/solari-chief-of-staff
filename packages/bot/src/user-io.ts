import type { UserIO } from '@chief-of-staff/core';

import type { SendToUser } from './outbound.js';

/**
 * The task engine's question port, over the outbound door (auto-cancel-path
 * spec: the round trip).
 *
 * A question is a message like any other: one row in `deliveries`, sent to
 * the chat the person bound, retried the way every send is. The engine has
 * already written the question onto the task before it calls this, so the
 * only thing this can get wrong is to say the question arrived when it did
 * not - which is why anything short of `sent` is a throw. The engine records
 * the throw as a failed delivery step beside the question, and the task
 * stays parked where a later delivery, or the person opening the dashboard,
 * can still answer it. Nobody to send to is the door's own error, thrown
 * through, so the trail says which it was.
 */
export function createTelegramUserIO(sendToUser: SendToUser): UserIO {
  return {
    ask: async (question) => {
      const delivery = await sendToUser(question.userId, question.question);
      if (delivery.status !== 'sent') {
        throw new Error(`the question was not delivered: ${delivery.error ?? delivery.status}`);
      }
    },
  };
}
