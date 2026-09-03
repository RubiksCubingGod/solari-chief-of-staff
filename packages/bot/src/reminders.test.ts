import type { Delivery } from '@chief-of-staff/db';
import { describe, expect, it } from 'vitest';

import { NoBindingError, type SendToUser } from './outbound.js';
import { createReminderSender } from './reminders.js';

/**
 * The adapter between the scan's send port and s3's outbound door. The door
 * answers with a delivery row or throws `NoBindingError`; the scan wants one of
 * three outcomes and never wants to know what a delivery row is. Anything else
 * the door throws is a crash and stays one.
 */

function delivery(overrides: Partial<Delivery>): Delivery {
  return {
    id: 'delivery-1',
    userId: 'user-1',
    chatId: '4242',
    text: 'Reminder: Gym renews on 2026-09-12 (in 3 days).',
    status: 'sent',
    attempts: 1,
    error: null,
    createdAt: new Date('2026-09-09T09:00:00Z'),
    settledAt: new Date('2026-09-09T09:00:01Z'),
    dedupKey: null,
    ...overrides,
  };
}

const over = (answer: () => Promise<Delivery>): SendToUser => {
  return () => answer();
};

describe('createReminderSender', () => {
  it('hands back the delivery a sent message was recorded as', async () => {
    const send = createReminderSender(over(() => Promise.resolve(delivery({ id: 'delivery-7' }))));

    await expect(send('user-1', 'hello')).resolves.toEqual({
      kind: 'sent',
      deliveryId: 'delivery-7',
    });
  });

  it('passes the user and the text through to the door untouched', async () => {
    const seen: [string, string][] = [];
    const send = createReminderSender((userId, text) => {
      seen.push([userId, text]);
      return Promise.resolve(delivery({ userId, text }));
    });

    await send('user-9', 'Reminder: Taxes is due by 2026-10-01 (in 7 days).');

    expect(seen).toEqual([['user-9', 'Reminder: Taxes is due by 2026-10-01 (in 7 days).']]);
  });

  it('reports a failed delivery with the row and the reason, so the scan can retry it later', async () => {
    const send = createReminderSender(
      over(() =>
        Promise.resolve(
          delivery({ id: 'delivery-8', status: 'failed', attempts: 3, error: 'Telegram: 502' }),
        ),
      ),
    );

    await expect(send('user-1', 'hello')).resolves.toEqual({
      kind: 'failed',
      deliveryId: 'delivery-8',
      error: 'Telegram: 502',
    });
  });

  it('gives a failure with no words a reason anyway, so the row never says failed and nothing else', async () => {
    const send = createReminderSender(
      over(() => Promise.resolve(delivery({ id: 'delivery-9', status: 'failed', error: null }))),
    );

    await expect(send('user-1', 'hello')).resolves.toEqual({
      kind: 'failed',
      deliveryId: 'delivery-9',
      error: 'the delivery failed without a reason',
    });
  });

  it('reports a person with no chat bound as unbound rather than as a failure', async () => {
    const send = createReminderSender(over(() => Promise.reject(new NoBindingError('user-1'))));

    await expect(send('user-1', 'hello')).resolves.toEqual({ kind: 'unbound' });
  });

  it('lets any other error through: a database that is down is a crash, not an outcome', async () => {
    const send = createReminderSender(over(() => Promise.reject(new Error('connection refused'))));

    await expect(send('user-1', 'hello')).rejects.toThrow('connection refused');
  });
});
