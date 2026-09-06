import { describe, expect, it } from 'vitest';

import { ANTHROPIC_KEY_VARIABLE, LIVE_LLM_FLAG, liveLlmSkipReason } from './live.js';

const WHAT = 'the live agentic smoke';

describe('liveLlmSkipReason', () => {
  it('skips without the opt-in, key or no key, and names what was skipped', () => {
    expect(liveLlmSkipReason({}, WHAT)).toBe(
      'ANTHROPIC_LIVE_LLM is not set to an opt-in value (1, true, yes, on), so the live agentic smoke was skipped rather than billed.',
    );
    expect(liveLlmSkipReason({ [ANTHROPIC_KEY_VARIABLE]: 'sk-ant-something' }, WHAT)).toContain(
      'not set to an opt-in value',
    );
    for (const flag of ['0', 'false', 'no', 'off', 'maybe', '']) {
      expect(liveLlmSkipReason({ [LIVE_LLM_FLAG]: flag, [ANTHROPIC_KEY_VARIABLE]: 'k' }, WHAT)).toContain(
        LIVE_LLM_FLAG,
      );
    }
  });

  it('skips with the opt-in but no key, naming the variable to set', () => {
    expect(liveLlmSkipReason({ [LIVE_LLM_FLAG]: '1' }, WHAT)).toBe(
      'ANTHROPIC_API_KEY is not configured, so the live agentic smoke was skipped. Set it as a repository secret in CI, or in .env locally.',
    );
    expect(liveLlmSkipReason({ [LIVE_LLM_FLAG]: 'yes', [ANTHROPIC_KEY_VARIABLE]: '   ' }, WHAT)).toContain(
      ANTHROPIC_KEY_VARIABLE,
    );
  });

  it('runs only with both, however the yes is spelled', () => {
    for (const flag of ['1', 'true', 'YES', ' On ']) {
      expect(liveLlmSkipReason({ [LIVE_LLM_FLAG]: flag, [ANTHROPIC_KEY_VARIABLE]: 'k' }, WHAT)).toBeUndefined();
    }
  });
});
