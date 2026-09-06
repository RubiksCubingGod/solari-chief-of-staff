import type { RateLimitPolicy } from './config.js';

/** What the limiter decided about one message. */
export type RateLimitVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly notify: boolean };

export interface RateLimiter {
  check(chatId: string): RateLimitVerdict;
  /** Live bucket count. Exported so the sweep is assertable rather than assumed. */
  readonly size: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
  /** When this chat was last told it is being refused, or 0 if never. */
  noticedAt: number;
}

const ALLOWED: RateLimitVerdict = { allowed: true };

/**
 * Per-chat token buckets, held in memory.
 *
 * Memory is the right home for this and Postgres is not: a bucket is worth
 * exactly as much as the process that owns the connection the flood is arriving
 * on, and losing it on restart costs a flooder one extra burst rather than
 * costing the user anything. Nothing downstream reads it, so it is not state in
 * the sense ARCHITECTURE §5 means.
 *
 * The clock is injected so the refill is provable without waiting for it.
 */
export function createRateLimiter(
  policy: RateLimitPolicy,
  now: () => number = Date.now,
): RateLimiter {
  const buckets = new Map<string, Bucket>();
  const tokensPerMs = policy.refillPerMinute / 60_000;
  /** How long a bucket takes to go from empty to full, and so how long an idle chat is worth remembering. */
  const idleMs = policy.burst / tokensPerMs;

  function sweep(at: number): void {
    for (const [chatId, bucket] of buckets) {
      const restedFor = at - bucket.updatedAt;
      // A bucket that has refilled to full says nothing a fresh bucket would
      // not, except while its notice window is still running.
      if (restedFor >= idleMs && at - bucket.noticedAt >= policy.noticeWindowMs) {
        buckets.delete(chatId);
      }
    }
  }

  return {
    get size() {
      return buckets.size;
    },

    check(chatId: string): RateLimitVerdict {
      const at = now();
      sweep(at);

      const existing = buckets.get(chatId);
      const bucket: Bucket = existing ?? { tokens: policy.burst, updatedAt: at, noticedAt: 0 };
      if (existing !== undefined) {
        bucket.tokens = Math.min(
          policy.burst,
          bucket.tokens + (at - bucket.updatedAt) * tokensPerMs,
        );
        bucket.updatedAt = at;
      }
      buckets.set(chatId, bucket);

      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return ALLOWED;
      }

      // Refused either way; the only question is whether this chat has been
      // told why recently enough that repeating it would be noise.
      const notify = at - bucket.noticedAt >= policy.noticeWindowMs;
      if (notify) bucket.noticedAt = at;
      return { allowed: false, notify };
    },
  };
}
