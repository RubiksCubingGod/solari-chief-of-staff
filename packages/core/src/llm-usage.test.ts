import { describe, expect, it } from 'vitest';

import {
  OPUS_5_PRICING,
  ZERO_LLM_USAGE,
  addLlmUsage,
  chargeLlmCall,
  costOfLlmUsage,
  emptyTaskLlmUsage,
  roundUsd,
  totalLlmTokens,
  type LlmUsage,
} from './llm-usage.js';

const call: LlmUsage = {
  inputTokens: 1_000,
  outputTokens: 50,
  cacheCreationInputTokens: 400,
  cacheReadInputTokens: 200,
};

describe('token arithmetic', () => {
  it('adds every kind of token separately', () => {
    expect(addLlmUsage(call, call)).toEqual({
      inputTokens: 2_000,
      outputTokens: 100,
      cacheCreationInputTokens: 800,
      cacheReadInputTokens: 400,
    });
    expect(addLlmUsage(ZERO_LLM_USAGE, call)).toEqual(call);
  });

  it('counts every token a call touched toward a budget', () => {
    expect(totalLlmTokens(call)).toBe(1_650);
    expect(totalLlmTokens(ZERO_LLM_USAGE)).toBe(0);
  });
});

describe('cost', () => {
  it('prices each kind of token at its own rate and rounds to the micro-dollar', () => {
    // 1000 in at $5 + 50 out at $25 + 400 cache writes at $6.25 + 200 cache reads at $0.50, per million.
    expect(costOfLlmUsage(call, OPUS_5_PRICING)).toBe(0.00885);
    expect(costOfLlmUsage(ZERO_LLM_USAGE, OPUS_5_PRICING)).toBe(0);
    expect(costOfLlmUsage({ ...ZERO_LLM_USAGE, outputTokens: 1 }, OPUS_5_PRICING)).toBe(0.000025);
  });

  it('rounds sums so a long run of calls does not drift', () => {
    expect(roundUsd(0.1 + 0.2)).toBe(0.3);
    expect(roundUsd(0.0000004)).toBe(0);
    expect(roundUsd(0.0000005)).toBe(0.000001);
  });

  it('charges a call to a task total, counting the call', () => {
    const first = chargeLlmCall(emptyTaskLlmUsage('claude-opus-5'), call, OPUS_5_PRICING);
    expect(first).toEqual({ ...call, model: 'claude-opus-5', calls: 1, costUsd: 0.00885 });
    const second = chargeLlmCall(first, { ...ZERO_LLM_USAGE, outputTokens: 4 }, OPUS_5_PRICING);
    expect(second).toEqual({
      ...call,
      outputTokens: 54,
      model: 'claude-opus-5',
      calls: 2,
      costUsd: 0.00895,
    });
  });
});
