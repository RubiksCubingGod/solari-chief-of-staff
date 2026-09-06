import { describe, expect, it } from 'vitest';

import { createRateLimiter, type RateLimiter } from './rate-limit.js';

const POLICY = { burst: 3, refillPerMinute: 60, noticeWindowMs: 60_000 } as const;

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

/** Spends `count` messages from a chat, for tests that care only what follows. */
function spend(limiter: RateLimiter, chatId: string, count: number): void {
  for (let sent = 0; sent < count; sent += 1) limiter.check(chatId);
}

describe('createRateLimiter', () => {
  it('lets a chat spend its whole burst', () => {
    const limiter = createRateLimiter(POLICY, clock().now);

    const verdicts = [1, 2, 3].map(() => limiter.check('chat-a'));

    expect(verdicts.map((verdict) => verdict.allowed)).toEqual([true, true, true]);
  });

  it('refuses the message after the burst and says so exactly once', () => {
    const limiter = createRateLimiter(POLICY, clock().now);
    spend(limiter, 'chat-a', 3);

    const first = limiter.check('chat-a');
    const second = limiter.check('chat-a');
    const third = limiter.check('chat-a');

    expect(first).toEqual({ allowed: false, notify: true });
    // Still refused, but silently: the flood does not get a reply per message.
    expect(second).toEqual({ allowed: false, notify: false });
    expect(third).toEqual({ allowed: false, notify: false });
  });

  it('meters each chat separately', () => {
    const limiter = createRateLimiter(POLICY, clock().now);
    spend(limiter, 'chat-a', 4);

    // One chat exhausting itself must not refuse anybody else.
    expect(limiter.check('chat-b').allowed).toBe(true);
  });

  it('refills over time, so a refused chat recovers without restarting anything', () => {
    const time = clock();
    const limiter = createRateLimiter(POLICY, time.now);
    spend(limiter, 'chat-a', 3);
    expect(limiter.check('chat-a').allowed).toBe(false);

    // 60 tokens a minute is one a second.
    time.advance(1000);

    expect(limiter.check('chat-a').allowed).toBe(true);
  });

  it('never refills past the burst, however long a chat stays quiet', () => {
    const time = clock();
    const limiter = createRateLimiter(POLICY, time.now);

    time.advance(60 * 60 * 1000);

    expect([1, 2, 3].map(() => limiter.check('chat-a').allowed)).toEqual([true, true, true]);
    expect(limiter.check('chat-a').allowed).toBe(false);
  });

  it('explains itself again in the next notice window', () => {
    const time = clock();
    const limiter = createRateLimiter(POLICY, time.now);
    spend(limiter, 'chat-a', 3);
    expect(limiter.check('chat-a')).toEqual({ allowed: false, notify: true });

    // A chat still flooding an hour later is a chat that has not been told
    // recently, so the notice is worth repeating once.
    time.advance(POLICY.noticeWindowMs);
    spend(limiter, 'chat-a', 3);

    expect(limiter.check('chat-a')).toEqual({ allowed: false, notify: true });
  });

  it('forgets chats that have been idle long enough to be back at full burst', () => {
    const time = clock();
    const limiter = createRateLimiter(POLICY, time.now);
    limiter.check('chat-a');
    expect(limiter.size).toBe(1);

    time.advance(60_000);
    limiter.check('chat-b');

    // Otherwise the map is a slow leak: one entry per chat that ever spoke,
    // for the life of the process.
    expect(limiter.size).toBe(1);
  });
});
