import { describe, expect, it } from 'vitest';

import { createNoticeGate } from './notice-gate.js';

const WINDOW_MS = 60_000;

/** A clock the test moves by hand, so no assertion here waits on real time. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let current = 1_000_000;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('createNoticeGate', () => {
  it('says yes the first time and no for the rest of the window', () => {
    const gate = createNoticeGate(WINDOW_MS, clock().now);

    expect(gate.due('chat-a')).toBe(true);
    expect(gate.due('chat-a')).toBe(false);
    expect(gate.due('chat-a')).toBe(false);
  });

  it('says yes again once the window has passed', () => {
    const time = clock();
    const gate = createNoticeGate(WINDOW_MS, time.now);
    expect(gate.due('chat-a')).toBe(true);

    time.advance(WINDOW_MS);

    // Somebody still trying a window later has not been told recently, and
    // silence at that point reads as a bot that is broken rather than strict.
    expect(gate.due('chat-a')).toBe(true);
  });

  it('stays silent right up to the edge of the window', () => {
    const time = clock();
    const gate = createNoticeGate(WINDOW_MS, time.now);
    gate.due('chat-a');

    time.advance(WINDOW_MS - 1);

    expect(gate.due('chat-a')).toBe(false);
  });

  it('tracks each chat separately, so one being told does not silence another', () => {
    const gate = createNoticeGate(WINDOW_MS, clock().now);

    expect(gate.due('chat-a')).toBe(true);
    expect(gate.due('chat-b')).toBe(true);
  });

  it('forgets a chat once its window has passed', () => {
    const time = clock();
    const gate = createNoticeGate(WINDOW_MS, time.now);
    gate.due('chat-a');
    expect(gate.size).toBe(1);

    time.advance(WINDOW_MS);
    gate.due('chat-b');

    // Otherwise the map is a slow leak: one entry per chat that ever spoke,
    // for the life of the process.
    expect(gate.size).toBe(1);
  });
});
