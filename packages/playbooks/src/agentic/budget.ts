import { totalLlmTokens, type LlmUsage } from '@chief-of-staff/core';

/**
 * The three hard limits a mission runs under, enforced by the runner rather
 * than asked of the model. ARCHITECTURE §3.2 names them: 40 steps, ten
 * minutes, a token cap. Hitting any one ends the mission failed with a
 * `budget` event, and whatever was spent by then stays on the row.
 */
export interface AgenticBudgets {
  /**
   * Model turns. Every answer the model gives spends one, whether it called
   * a tool, called a tool badly, or said something and called nothing: a
   * turn that moves nothing forward still has to run out.
   */
  readonly maxToolCalls: number;
  /** Every token the mission's calls touched: input, output, cache writes and cache reads. */
  readonly maxTokens: number;
  /** From the mission's first moment to its last, in milliseconds. */
  readonly maxWallMs: number;
}

export const DEFAULT_AGENTIC_BUDGETS: AgenticBudgets = {
  maxToolCalls: 40,
  maxTokens: 400_000,
  maxWallMs: 10 * 60 * 1_000,
};

export type BudgetAxis = 'tool_calls' | 'tokens' | 'wall_time';

/** Which limit was hit, and where the count stood. What the `budget` event carries. */
export interface BudgetExhaustion {
  readonly axis: BudgetAxis;
  readonly used: number;
  readonly limit: number;
}

/** The mission's spend so far, in the three units the budgets count. */
export interface BudgetLedger {
  readonly toolCalls: number;
  readonly tokens: number;
  readonly elapsedMs: number;
}

const AXIS_WORDS: Record<BudgetAxis, string> = {
  tool_calls: 'tool calls',
  tokens: 'tokens',
  wall_time: 'wall time',
};

/** The sentence a failed task carries for an exhausted budget. */
export function describeExhaustion(exhaustion: BudgetExhaustion): string {
  const unit = exhaustion.axis === 'wall_time' ? ' ms' : '';
  return `budget exhausted: ${AXIS_WORDS[exhaustion.axis]} (${String(exhaustion.used)} of ${String(exhaustion.limit)}${unit})`;
}

/**
 * Whether the mission may go on. Wall time is checked first because it is
 * the one a caller can least do anything about; then tokens, which the last
 * call may already have overspent; then turns. A limit is exhausted when the
 * count reaches it: the check runs before the thing it would admit, so the
 * limit is a count of things allowed, not of things attempted.
 */
export function checkBudgets(
  budgets: AgenticBudgets,
  ledger: BudgetLedger,
  about: 'turn' | 'tokens' | 'tool',
): BudgetExhaustion | undefined {
  if (ledger.elapsedMs >= budgets.maxWallMs) {
    return { axis: 'wall_time', used: ledger.elapsedMs, limit: budgets.maxWallMs };
  }
  if (ledger.tokens >= budgets.maxTokens) {
    return { axis: 'tokens', used: ledger.tokens, limit: budgets.maxTokens };
  }
  if (about === 'turn' && ledger.toolCalls >= budgets.maxToolCalls) {
    return { axis: 'tool_calls', used: ledger.toolCalls, limit: budgets.maxToolCalls };
  }
  return undefined;
}

/** The ledger after one more answered call. */
export function chargeTokens(ledger: BudgetLedger, usage: LlmUsage): BudgetLedger {
  return { ...ledger, tokens: ledger.tokens + totalLlmTokens(usage) };
}

/** How long a backoff may wait without crossing the wall-time limit; nothing when it already has. */
export function backoffWithin(
  budgets: AgenticBudgets,
  elapsedMs: number,
  wantedMs: number,
): number | undefined {
  const remaining = budgets.maxWallMs - elapsedMs;
  if (remaining <= 0) return undefined;
  return Math.min(wantedMs, remaining);
}
