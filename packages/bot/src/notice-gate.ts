/**
 * Says something at most once per window, per chat.
 *
 * Two different refusals need this — the flood notice and the how-to-bind
 * reply — and they need it for the same reason: the refusal itself is
 * unconditional, but repeating the explanation to something that is looping
 * would make the bot the second half of the flood. It is deliberately not part
 * of the rate limiter, whose token bucket answers a different question.
 */
export interface NoticeGate {
  /** Whether this chat is due to be told, and marks it told when it is. */
  due(chatId: string): boolean;
  /** Chats currently remembered, so the map's size is assertable. */
  readonly size: number;
}

export function createNoticeGate(windowMs: number, now: () => number = Date.now): NoticeGate {
  const lastToldAt = new Map<string, number>();

  /**
   * Drops chats whose window has passed. Without it the map is a slow leak of
   * one entry per chat that ever spoke, for the life of the process — and an
   * entry past its window is one that would say yes anyway.
   */
  function sweep(at: number): void {
    for (const [chatId, told] of lastToldAt) {
      if (at - told >= windowMs) lastToldAt.delete(chatId);
    }
  }

  return {
    due(chatId: string): boolean {
      const at = now();
      sweep(at);
      if (lastToldAt.has(chatId)) return false;
      lastToldAt.set(chatId, at);
      return true;
    },
    get size(): number {
      return lastToldAt.size;
    },
  };
}
