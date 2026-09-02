import { describe, expect, it } from 'vitest';

import {
  DEFAULT_AGENTIC_BUDGETS,
  backoffWithin,
  chargeTokens,
  checkBudgets,
  describeExhaustion,
  type AgenticBudgets,
  type BudgetLedger,
} from './budget.js';

const budgets: AgenticBudgets = { maxToolCalls: 3, maxTokens: 1_000, maxWallMs: 5_000 };
const fresh: BudgetLedger = { toolCalls: 0, tokens: 0, elapsedMs: 0 };

describe('the defaults', () => {
  it('are the limits ARCHITECTURE §3.2 names: 40 turns, ten minutes, and a token cap', () => {
    expect(DEFAULT_AGENTIC_BUDGETS).toEqual({ maxToolCalls: 40, maxTokens: 400_000, maxWallMs: 600_000 });
  });
});

describe('checkBudgets', () => {
  it('admits a fresh ledger on every axis', () => {
    expect(checkBudgets(budgets, fresh, 'turn')).toBeUndefined();
    expect(checkBudgets(budgets, fresh, 'tokens')).toBeUndefined();
    expect(checkBudgets(budgets, fresh, 'tool')).toBeUndefined();
  });

  it('counts a turn as spent when the count reaches the limit, and only before a turn', () => {
    const spent = { ...fresh, toolCalls: 3 };
    expect(checkBudgets(budgets, { ...fresh, toolCalls: 2 }, 'turn')).toBeUndefined();
    expect(checkBudgets(budgets, spent, 'turn')).toEqual({ axis: 'tool_calls', used: 3, limit: 3 });
    // The turn that reached the limit still gets to run its tools and be charged.
    expect(checkBudgets(budgets, spent, 'tool')).toBeUndefined();
    expect(checkBudgets(budgets, spent, 'tokens')).toBeUndefined();
  });

  it('counts tokens as spent when they reach the limit, whatever the check is about', () => {
    expect(checkBudgets(budgets, { ...fresh, tokens: 999 }, 'tokens')).toBeUndefined();
    expect(checkBudgets(budgets, { ...fresh, tokens: 1_000 }, 'tokens')).toEqual({
      axis: 'tokens',
      used: 1_000,
      limit: 1_000,
    });
    expect(checkBudgets(budgets, { ...fresh, tokens: 1_500 }, 'tool')).toEqual({
      axis: 'tokens',
      used: 1_500,
      limit: 1_000,
    });
  });

  it('counts wall time as spent when the clock reaches the limit, ahead of every other axis', () => {
    expect(checkBudgets(budgets, { ...fresh, elapsedMs: 4_999 }, 'tool')).toBeUndefined();
    expect(checkBudgets(budgets, { toolCalls: 3, tokens: 9_000, elapsedMs: 5_000 }, 'turn')).toEqual({
      axis: 'wall_time',
      used: 5_000,
      limit: 5_000,
    });
  });

  it('ranks tokens over turns when both are spent', () => {
    expect(checkBudgets(budgets, { toolCalls: 3, tokens: 1_000, elapsedMs: 0 }, 'turn')).toMatchObject({
      axis: 'tokens',
    });
  });
});

describe('chargeTokens', () => {
  it('adds every kind of token the call touched', () => {
    const charged = chargeTokens(
      { ...fresh, tokens: 10 },
      { inputTokens: 100, outputTokens: 20, cacheCreationInputTokens: 30, cacheReadInputTokens: 40 },
    );
    expect(charged).toEqual({ ...fresh, tokens: 200 });
  });
});

describe('describeExhaustion', () => {
  it('says which budget ran out and where the count stood, with a unit only for time', () => {
    expect(describeExhaustion({ axis: 'tool_calls', used: 40, limit: 40 })).toBe(
      'budget exhausted: tool calls (40 of 40)',
    );
    expect(describeExhaustion({ axis: 'tokens', used: 400_123, limit: 400_000 })).toBe(
      'budget exhausted: tokens (400123 of 400000)',
    );
    expect(describeExhaustion({ axis: 'wall_time', used: 600_500, limit: 600_000 })).toBe(
      'budget exhausted: wall time (600500 of 600000 ms)',
    );
  });
});

describe('backoffWithin', () => {
  it('waits the wanted time while it fits, the remaining time when it does not, and not at all past the limit', () => {
    expect(backoffWithin(budgets, 1_000, 500)).toBe(500);
    expect(backoffWithin(budgets, 4_800, 500)).toBe(200);
    expect(backoffWithin(budgets, 5_000, 500)).toBeUndefined();
    expect(backoffWithin(budgets, 6_000, 500)).toBeUndefined();
  });
});
