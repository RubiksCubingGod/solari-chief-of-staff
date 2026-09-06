import type { ReminderSender } from '@chief-of-staff/db';

import { NoBindingError, type SendToUser } from './outbound.js';

/**
 * The scan's send port, over s3's outbound door (reminder-path spec).
 *
 * The door answers with the delivery row it settled, or throws
 * `NoBindingError` when there is nobody to send to. The scan wants neither:
 * it wants to know whether the message went, and if not, whether that is a
 * fact about the person (unbound) or about the network (failed, with the
 * words to retry on). Everything else the door throws is a crash and stays
 * one, so the job harness retries the scan rather than the scan recording a
 * database outage as a failed reminder.
 */
export function createReminderSender(sendToUser: SendToUser): ReminderSender {
  return async (userId, text) => {
    try {
      const delivery = await sendToUser(userId, text);
      if (delivery.status === 'sent') return { kind: 'sent', deliveryId: delivery.id };
      return {
        kind: 'failed',
        deliveryId: delivery.id,
        error: delivery.error ?? 'the delivery failed without a reason',
      };
    } catch (error: unknown) {
      if (error instanceof NoBindingError) return { kind: 'unbound' };
      throw error;
    }
  };
}
