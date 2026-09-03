import { describe, expect, it } from 'vitest';

import {
  BOOKING_OUTCOMES,
  WATCH_EVENT_TYPES,
  bookingDedupKey,
  createRecordingNotifier,
  type BookingEvent,
  type TriggeredEvent,
  type WatchEvent,
} from './notifier.js';

/**
 * The notifier port is where this sprint ends: real Telegram delivery is
 * calendar-wiring's. What is proven here is the double every pipeline proof
 * asserts against - that it records what was emitted, in order, and that it
 * can tell a duplicate delivery from a new event by the dedup key.
 */

function triggered(
  overrides: Partial<Omit<TriggeredEvent, 'type'>> & { readonly dedupKey: string },
): TriggeredEvent {
  return {
    type: 'triggered',
    watchId: 'watch-1',
    userId: 'user-1',
    url: 'https://shop.test/item/1',
    occurredAt: '2026-09-02T00:00:00.000Z',
    kind: 'price',
    condition: { kind: 'price', drops_below: 15, rises_above: null },
    previous: null,
    current: { kind: 'price', amount: 14.99, currency: 'USD', raw: '$14.99' },
    reason: 'price 14.99 drops below 15',
    ...overrides,
  };
}

describe('the recording notifier', () => {
  it('records every event it is handed, oldest first', async () => {
    const notifier = createRecordingNotifier();
    const first = triggered({ dedupKey: 'a' });
    const second: WatchEvent = {
      type: 'blocked',
      watchId: 'watch-2',
      userId: 'user-1',
      url: 'https://shop.test/item/2',
      occurredAt: '2026-09-02T00:01:00.000Z',
      dedupKey: 'b',
      tiersTried: ['http', 'browser', 'stealth'],
      reason: 'every tier was blocked',
    };

    await notifier.notify(first);
    await notifier.notify(second);

    expect(notifier.events).toEqual([first, second]);
    expect(notifier.calls).toEqual([first, second]);
  });

  it('counts a redelivery under the same dedup key as a call but not as a new event', async () => {
    const notifier = createRecordingNotifier();
    const event = triggered({ dedupKey: 'same' });

    await notifier.notify(event);
    await notifier.notify({ ...event, occurredAt: '2026-09-02T00:05:00.000Z' });

    expect(notifier.calls).toHaveLength(2);
    expect(notifier.events).toEqual([event]);
  });

  it('filters events by watch', async () => {
    const notifier = createRecordingNotifier();
    await notifier.notify(triggered({ dedupKey: 'a', watchId: 'watch-1' }));
    await notifier.notify(triggered({ dedupKey: 'b', watchId: 'watch-2' }));
    await notifier.notify(triggered({ dedupKey: 'c', watchId: 'watch-1' }));

    expect(notifier.eventsFor('watch-1').map((event) => event.dedupKey)).toEqual(['a', 'c']);
    expect(notifier.eventsFor('watch-3')).toEqual([]);
  });

  it('can be told to fail the next delivery, once, so a retry can be proven', async () => {
    const notifier = createRecordingNotifier();
    notifier.failNextWith(new Error('the chat was unreachable'));

    await expect(notifier.notify(triggered({ dedupKey: 'a' }))).rejects.toThrow(
      'the chat was unreachable',
    );
    // A failed delivery is not a delivery: nothing is recorded for it.
    expect(notifier.calls).toEqual([]);

    await notifier.notify(triggered({ dedupKey: 'a' }));

    expect(notifier.events).toHaveLength(1);
  });

  it('hands back copies, so a proof cannot edit the record it is asserting on', async () => {
    const notifier = createRecordingNotifier();
    await notifier.notify(triggered({ dedupKey: 'a' }));

    const snapshot = notifier.events;
    await notifier.notify(triggered({ dedupKey: 'b' }));

    expect(snapshot).toHaveLength(1);
    expect(notifier.events).toHaveLength(2);
  });
});

describe('WATCH_EVENT_TYPES', () => {
  it('names the four things the engine can tell a person', () => {
    expect(WATCH_EVENT_TYPES).toEqual(['triggered', 'blocked', 'degraded', 'booking']);
  });
});

describe('the booking event', () => {
  const booked: BookingEvent = {
    type: 'booking',
    watchId: 'watch-1',
    userId: 'user-1',
    url: 'http://127.0.0.1:4304/appointments',
    occurredAt: '2026-09-02T00:02:00.000Z',
    dedupKey: bookingDedupKey('watch-1', 'task-1', 'booked'),
    taskId: 'task-1',
    slot: { id: 'Tue 8 Sep, 09:00', label: 'Tue 8 Sep, 09:00' },
    outcome: 'booked',
    reference: 'DMV-000001',
    reason: 'Tue 8 Sep, 09:00 is booked: reference DMV-000001',
  };

  it('is recorded like any other event', async () => {
    const notifier = createRecordingNotifier();
    await notifier.notify(booked);
    expect(notifier.eventsFor('watch-1')).toEqual([booked]);
  });

  it('names the three things that can become of the watch', () => {
    expect(BOOKING_OUTCOMES).toEqual(['booked', 'rearmed', 'paused']);
  });
});

describe('bookingDedupKey', () => {
  it('is one key per watch, task and outcome, and a different key for any other', () => {
    const key = bookingDedupKey('watch-1', 'task-1', 'booked');
    expect(key).toMatch(/^[0-9a-f]{64}$/u);
    expect(bookingDedupKey('watch-1', 'task-1', 'booked')).toBe(key);
    expect(bookingDedupKey('watch-1', 'task-1', 'rearmed')).not.toBe(key);
    expect(bookingDedupKey('watch-1', 'task-2', 'booked')).not.toBe(key);
    expect(bookingDedupKey('watch-2', 'task-1', 'booked')).not.toBe(key);
  });
});
