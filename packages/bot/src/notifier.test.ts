import type { BookingEvent, NotifierPort, TriggeredEvent, WatchEvent } from '@chief-of-staff/core';
import type { Delivery } from '@chief-of-staff/db';
import { describe, expect, it } from 'vitest';

import { createTelegramNotifier, renderWatchEvent } from './notifier.js';
import { NoBindingError, type SendToUser } from './outbound.js';

/**
 * The notifier port over the outbound door: what the person reads for each
 * of the four events, and what the adapter does when there is nobody to send
 * to or the send did not arrive. The door itself, with its delivery rows and
 * the dedup key, is proven in `notifier.integration.test.ts`.
 */

const URL = 'https://shop.test/item/1';

function triggered(overrides: Partial<Omit<TriggeredEvent, 'type'>> = {}): TriggeredEvent {
  return {
    type: 'triggered',
    watchId: 'watch-1',
    userId: 'user-1',
    url: URL,
    occurredAt: '2026-09-03T08:00:00.000Z',
    dedupKey: 'key-triggered',
    kind: 'price',
    condition: { kind: 'price', drops_below: 15, rises_above: null },
    previous: null,
    current: { kind: 'price', amount: 14.99, currency: 'USD', raw: '$14.99' },
    reason: 'price 14.99 drops below 15',
    ...overrides,
  };
}

function booking(overrides: Partial<Omit<BookingEvent, 'type'>> = {}): BookingEvent {
  return {
    type: 'booking',
    watchId: 'watch-2',
    userId: 'user-1',
    url: 'http://127.0.0.1:4304/appointments',
    occurredAt: '2026-09-03T08:00:00.000Z',
    dedupKey: 'key-booking',
    taskId: 'task-1',
    slot: { id: 'tue-0900', label: 'Tue 8 Sep, 09:00' },
    outcome: 'booked',
    reference: 'DMV-000123',
    reason: 'Tue 8 Sep, 09:00 is booked: reference DMV-000123',
    ...overrides,
  };
}

const BLOCKED: WatchEvent = {
  type: 'blocked',
  watchId: 'watch-1',
  userId: 'user-1',
  url: URL,
  occurredAt: '2026-09-03T08:00:00.000Z',
  dedupKey: 'key-blocked',
  tiersTried: ['http', 'browser', 'stealth'],
  reason: 'every tier was blocked',
};

const DEGRADED: WatchEvent = {
  type: 'degraded',
  watchId: 'watch-1',
  userId: 'user-1',
  url: URL,
  occurredAt: '2026-09-03T08:00:00.000Z',
  dedupKey: 'key-degraded',
  reason: 'the extractor broke three times in a row',
};

function delivery(status: Delivery['status'], error: string | null = null): Delivery {
  return {
    id: 'delivery-1',
    userId: 'user-1',
    chatId: '80001',
    text: '',
    status,
    attempts: 1,
    error,
    dedupKey: null,
    createdAt: new Date('2026-09-03T08:00:00.000Z'),
    settledAt: new Date('2026-09-03T08:00:01.000Z'),
  };
}

interface Door {
  readonly sendToUser: SendToUser;
  readonly sent: { userId: string; text: string; dedupKey: string | undefined }[];
}

function door(answer: (userId: string) => Promise<Delivery>): Door {
  const sent: Door['sent'] = [];
  return {
    sent,
    sendToUser: (userId, text, options) => {
      sent.push({ userId, text, dedupKey: options?.dedupKey });
      return answer(userId);
    },
  };
}

function fallback(): NotifierPort & { readonly events: WatchEvent[] } {
  const events: WatchEvent[] = [];
  return {
    events,
    notify(event) {
      events.push(event);
      return Promise.resolve();
    },
  };
}

describe('renderWatchEvent', () => {
  it('says what fired, where, and what became of a booking, in one sentence each', () => {
    expect(renderWatchEvent(triggered())).toBe(`Your watch fired: price 14.99 drops below 15. ${URL}`);
    expect(renderWatchEvent(BLOCKED)).toBe(`Your watch on ${URL} is blocked at every tier: every tier was blocked`);
    expect(renderWatchEvent(DEGRADED)).toBe(
      `Your watch on ${URL} has degraded and needs your attention: the extractor broke three times in a row`,
    );
    expect(renderWatchEvent(booking())).toBe(
      'Booked: Tue 8 Sep, 09:00, reference DMV-000123. Your watch on http://127.0.0.1:4304/appointments stays paused.',
    );
    expect(renderWatchEvent(booking({ outcome: 'rearmed', reference: null, reason: 'fakedmv no longer offers Tue 8 Sep, 09:00' }))).toBe(
      'Not booked: fakedmv no longer offers Tue 8 Sep, 09:00. Your watch on http://127.0.0.1:4304/appointments is looking again.',
    );
    expect(renderWatchEvent(booking({ outcome: 'paused', reference: null, reason: 'fakedmv is showing its blocked shell' }))).toBe(
      'Not booked: fakedmv is showing its blocked shell. Your watch on http://127.0.0.1:4304/appointments is paused for your attention.',
    );
  });
});

describe('the Telegram notifier', () => {
  it('sends the sentence to the person the event is for, keyed by the event, and resolves once it was sent', async () => {
    const outbound = door(() => Promise.resolve(delivery('sent')));
    const notifier = createTelegramNotifier(outbound.sendToUser, { fallback: fallback() });

    await notifier.notify(triggered());
    await notifier.notify(booking());

    expect(outbound.sent).toEqual([
      { userId: 'user-1', text: renderWatchEvent(triggered()), dedupKey: 'key-triggered' },
      { userId: 'user-1', text: renderWatchEvent(booking()), dedupKey: 'key-booking' },
    ]);
  });

  it('treats a delivery another emission is still sending as delivered', async () => {
    const outbound = door(() => Promise.resolve(delivery('pending')));
    const notifier = createTelegramNotifier(outbound.sendToUser, { fallback: fallback() });

    await expect(notifier.notify(triggered())).resolves.toBeUndefined();
  });

  it('hands the event to the fallback when the person has no chat bound, and sends nothing', async () => {
    const outbound = door((userId) => Promise.reject(new NoBindingError(userId)));
    const log = fallback();
    const notifier = createTelegramNotifier(outbound.sendToUser, { fallback: log });

    await notifier.notify(DEGRADED);

    expect(log.events).toEqual([DEGRADED]);
    expect(outbound.sent).toHaveLength(1);
  });

  it('throws when the delivery settled failed, so the producer retries instead of the port claiming delivery', async () => {
    const outbound = door(() => Promise.resolve(delivery('failed', 'telegram: 502 Bad Gateway')));
    const log = fallback();
    const notifier = createTelegramNotifier(outbound.sendToUser, { fallback: log });

    await expect(notifier.notify(BLOCKED)).rejects.toThrow('the blocked event was not delivered: telegram: 502 Bad Gateway');
    expect(log.events).toEqual([]);
  });

  it('lets any other failure of the door through untouched', async () => {
    const outbound = door(() => Promise.reject(new Error('the database is away')));
    const notifier = createTelegramNotifier(outbound.sendToUser, { fallback: fallback() });

    await expect(notifier.notify(triggered())).rejects.toThrow('the database is away');
  });
});
