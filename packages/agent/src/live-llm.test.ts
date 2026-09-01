import { describe, expect, it } from 'vitest';

import { ANTHROPIC_KEY_VARIABLE, LIVE_LLM_FLAG, liveLlmSkipReason } from './live-llm.js';

/**
 * The gate on the only test that spends money, proven rather than trusted. The
 * failure that matters is the quiet one: a guard that lets the live suite run
 * where nobody meant it to, which nothing else in the workspace would catch
 * until the bill arrived.
 */

const KEY = 'sk-ant-not-a-real-key';

describe('the live-LLM gate', () => {
  it('opens only when both the flag and the key are there', () => {
    expect(liveLlmSkipReason({ [LIVE_LLM_FLAG]: 'true', [ANTHROPIC_KEY_VARIABLE]: KEY })).toBeUndefined();
  });

  it('stays shut for a key with no opt-in, which is the expensive mistake', () => {
    const reason = liveLlmSkipReason({ [ANTHROPIC_KEY_VARIABLE]: KEY });

    expect(reason).toContain(LIVE_LLM_FLAG);
  });

  it('stays shut for an opt-in with no key', () => {
    const reason = liveLlmSkipReason({ [LIVE_LLM_FLAG]: 'yes' });

    expect(reason).toContain(ANTHROPIC_KEY_VARIABLE);
  });

  it('reads the flag by its meaning rather than its truthiness', () => {
    for (const yes of ['1', 'true', 'yes', 'on', 'YES', ' On ']) {
      expect(
        liveLlmSkipReason({ [LIVE_LLM_FLAG]: yes, [ANTHROPIC_KEY_VARIABLE]: KEY }),
        yes,
      ).toBeUndefined();
    }
    // `0` and `false` are truthy strings in JavaScript and mean "no" to every
    // person who writes them. Honouring the language over the intent would bill
    // somebody for the misunderstanding.
    for (const no of ['0', 'false', 'no', 'off', '']) {
      expect(
        liveLlmSkipReason({ [LIVE_LLM_FLAG]: no, [ANTHROPIC_KEY_VARIABLE]: KEY }),
        no,
      ).toContain(LIVE_LLM_FLAG);
    }
  });

  it('does not accept a key that is only whitespace', () => {
    const reason = liveLlmSkipReason({ [LIVE_LLM_FLAG]: '1', [ANTHROPIC_KEY_VARIABLE]: '   ' });

    expect(reason).toContain(ANTHROPIC_KEY_VARIABLE);
  });
});
