import { describe, expect, it } from 'vitest';

import {
  TELEGRAM_LIVE_CHAT_VARIABLE,
  TELEGRAM_LIVE_FLAG,
  TELEGRAM_TOKEN_VARIABLE,
  liveTelegramSkipReason,
} from './live-telegram.js';

/**
 * The gate on the only suite that reaches a phone, proven rather than trusted.
 * The failure that matters is the quiet one: a guard that lets the live suite
 * run where nobody meant it to, which nothing else in the workspace would
 * catch until somebody's phone buzzed during `pnpm check`.
 */

const TOKEN = '123456:not-a-real-token';
const CHAT = '80001';

const open = { [TELEGRAM_LIVE_FLAG]: 'true', [TELEGRAM_TOKEN_VARIABLE]: TOKEN, [TELEGRAM_LIVE_CHAT_VARIABLE]: CHAT };

describe('the live Telegram gate', () => {
  it('opens only when the flag, the token and the chat are all there', () => {
    expect(liveTelegramSkipReason(open)).toBeUndefined();
  });

  it('stays shut for a token with no opt-in, which is the mistake that buzzes a phone', () => {
    const reason = liveTelegramSkipReason({ ...open, [TELEGRAM_LIVE_FLAG]: '' });

    expect(reason).toContain(TELEGRAM_LIVE_FLAG);
  });

  it('stays shut for an opt-in with no token', () => {
    const reason = liveTelegramSkipReason({ ...open, [TELEGRAM_TOKEN_VARIABLE]: '' });

    expect(reason).toContain(TELEGRAM_TOKEN_VARIABLE);
  });

  it('stays shut with nowhere to send to', () => {
    const reason = liveTelegramSkipReason({ ...open, [TELEGRAM_LIVE_CHAT_VARIABLE]: '' });

    expect(reason).toContain(TELEGRAM_LIVE_CHAT_VARIABLE);
  });

  it('refuses a chat id that is not one, rather than asking Telegram to deliver to a name', () => {
    const reason = liveTelegramSkipReason({ ...open, [TELEGRAM_LIVE_CHAT_VARIABLE]: '@somebody' });

    expect(reason).toContain(TELEGRAM_LIVE_CHAT_VARIABLE);
    // A group chat is a negative number, and is a place a bot can be asked in.
    expect(liveTelegramSkipReason({ ...open, [TELEGRAM_LIVE_CHAT_VARIABLE]: '-100123' })).toBeUndefined();
  });

  it('reads the flag by its meaning rather than its truthiness', () => {
    for (const yes of ['1', 'true', 'yes', 'on', 'YES', ' On ']) {
      expect(liveTelegramSkipReason({ ...open, [TELEGRAM_LIVE_FLAG]: yes }), yes).toBeUndefined();
    }
    // `0` and `false` are truthy strings in JavaScript and mean "no" to every
    // person who writes them. Honouring the language over the intent would
    // message somebody for the misunderstanding.
    for (const no of ['0', 'false', 'no', 'off', '']) {
      expect(liveTelegramSkipReason({ ...open, [TELEGRAM_LIVE_FLAG]: no }), no).toContain(TELEGRAM_LIVE_FLAG);
    }
  });

  it('does not accept a token or a chat that is only whitespace', () => {
    expect(liveTelegramSkipReason({ ...open, [TELEGRAM_TOKEN_VARIABLE]: '   ' })).toContain(TELEGRAM_TOKEN_VARIABLE);
    expect(liveTelegramSkipReason({ ...open, [TELEGRAM_LIVE_CHAT_VARIABLE]: '   ' })).toContain(TELEGRAM_LIVE_CHAT_VARIABLE);
  });
});
