import type { Delivery } from '@chief-of-staff/db';
import { describe, expect, it } from 'vitest';

import { notifyOpsOfNight, renderOpsNotification, type OpsNight } from './ops-notification.js';
import type { SendToUser } from './outbound.js';

/**
 * The red-night notice over a stand-in door. Two promises: a night that is
 * not green reaches the person on call with every reason in it, and a green
 * one sends nothing at all.
 */

const RED: OpsNight = {
  date: '2026-09-03',
  colour: 'failed',
  counts: { passed: 2, failed: 1, errored: 1 },
  cost: { totalUsd: 1.93, solariUsd: 0.03, anthropicUsd: 1.9 },
  costTargetUsd: 5,
  reasons: [
    'watch case watch-checks failed: the price selector matched nothing',
    'mission case fixture-mission errored: the vendor answered 503',
  ],
};

const GREEN: OpsNight = {
  ...RED,
  colour: 'green',
  counts: { passed: 4, failed: 0, errored: 0 },
  reasons: [],
};

function delivered(userId: string, text: string): Delivery {
  return {
    id: 'delivery-1',
    userId,
    chatId: '80001',
    text,
    status: 'sent',
    attempts: 1,
    error: null,
    createdAt: new Date('2026-09-04T06:00:00Z'),
    settledAt: new Date('2026-09-04T06:00:01Z'),
    dedupKey: null,
  };
}

/** A door that records what it was asked to send and answers that it went. */
function door(): SendToUser & { readonly sent: { userId: string; text: string; dedupKey?: string }[] } {
  const sent: { userId: string; text: string; dedupKey?: string }[] = [];
  const send: SendToUser = (userId, text, options) => {
    sent.push({ userId, text, ...(options?.dedupKey === undefined ? {} : { dedupKey: options.dedupKey }) });
    return Promise.resolve(delivered(userId, text));
  };
  return Object.assign(send, { sent });
}

describe('renderOpsNotification', () => {
  it('says the date, the colour, the counts, every reason, and the cost against target', () => {
    const text = renderOpsNotification(RED, { runUrl: 'https://example.test/runs/1' });
    expect(text.split('\n')).toEqual([
      'Live ops 2026-09-03: FAILED',
      '2 passed, 1 failed, 1 errored',
      '- watch case watch-checks failed: the price selector matched nothing',
      '- mission case fixture-mission errored: the vendor answered 503',
      'Cost $1.93 of the $5.00 target (Solari $0.03, Anthropic $1.90)',
      'Run: https://example.test/runs/1',
    ]);
  });

  it('leaves the run line out when there is no run to point at', () => {
    expect(renderOpsNotification(RED)).not.toContain('Run:');
  });
});

describe('notifyOpsOfNight', () => {
  it('sends a red night to the person on call, once per night and colour', async () => {
    const send = door();

    const notice = await notifyOpsOfNight(send, 'ops-user', RED, { runUrl: 'https://example.test/runs/1' });

    expect(notice.sent).toBe(true);
    expect(send.sent).toEqual([
      { userId: 'ops-user', text: renderOpsNotification(RED, { runUrl: 'https://example.test/runs/1' }), dedupKey: 'live-ops:2026-09-03:failed' },
    ]);
    if (notice.sent) expect(notice.delivery.status).toBe('sent');
  });

  it('sends an errored night too: an outage is still a night somebody has to look at', async () => {
    const send = door();

    const notice = await notifyOpsOfNight(send, 'ops-user', { ...RED, colour: 'errored' });

    expect(notice.sent).toBe(true);
    expect(send.sent[0]?.text).toContain('Live ops 2026-09-03: ERRORED');
  });

  it('sends nothing on a green night, and says so', async () => {
    const send = door();

    const notice = await notifyOpsOfNight(send, 'ops-user', GREEN);

    expect(notice).toEqual({ sent: false, reason: '2026-09-03 was green; nothing to say' });
    expect(send.sent).toEqual([]);
  });

  it('lets the door’s own refusal through rather than reporting a notice that did not go', async () => {
    const refused: SendToUser = () => Promise.reject(new Error('no chat bound to ops-user'));

    await expect(notifyOpsOfNight(refused, 'ops-user', RED)).rejects.toThrow('no chat bound to ops-user');
  });
});
