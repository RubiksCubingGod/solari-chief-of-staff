import type { BlockedEvent, TriggeredEvent } from '@chief-of-staff/core';
import { describe, expect, it, vi } from 'vitest';

import { createLogNotifier } from './notifier.js';

const BLOCKED: BlockedEvent = {
  type: 'blocked',
  watchId: 'watch-1',
  userId: 'user-1',
  url: 'https://shop.test/product/widget',
  occurredAt: '2026-09-02T12:00:00.000Z',
  dedupKey: 'a'.repeat(64),
  tiersTried: ['http', 'browser'],
  reason: 'blocked at every tier tried (http, browser): challenge-markers',
};

const TRIGGERED: TriggeredEvent = {
  type: 'triggered',
  watchId: 'watch-1',
  userId: 'user-1',
  url: 'https://shop.test/product/widget',
  occurredAt: '2026-09-02T12:15:00.000Z',
  dedupKey: 'b'.repeat(64),
  kind: 'price',
  condition: { kind: 'price', drops_below: 15, rises_above: null },
  previous: { kind: 'price', amount: 19.99, currency: 'USD', raw: '$19.99' },
  current: { kind: 'price', amount: 14.99, currency: 'USD', raw: '$14.99' },
  reason: 'price 14.99 drops below 15',
};

describe('createLogNotifier', () => {
  it('writes every event as one JSON line, in order, and reads back whole', async () => {
    const lines: string[] = [];
    const notifier = createLogNotifier((line) => {
      lines.push(line);
    });

    await notifier.notify(BLOCKED);
    await notifier.notify(TRIGGERED);

    expect(lines).toHaveLength(2);
    expect(lines.every((line) => !line.includes('\n'))).toBe(true);
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([BLOCKED, TRIGGERED]);
  });

  it('writes to stdout when no sink is given', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await createLogNotifier().notify(TRIGGERED);
      expect(write).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledWith(`${JSON.stringify(TRIGGERED)}\n`);
    } finally {
      write.mockRestore();
    }
  });
});
