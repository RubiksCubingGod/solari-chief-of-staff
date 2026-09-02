/**
 * What a model call cost, in tokens and in money.
 *
 * The vocabulary is here rather than in the packages that spend or store it,
 * because both need the same words: the agentic runner adds up what the API
 * reported, and the task row carries the running total so the dashboard can
 * put a price on a task without re-reading its trail.
 */

/** Tokens as the API reports them for one call, or summed over many. */
export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
}

/** Dollars per million tokens, by the four kinds of token the API bills. */
export interface LlmPricing {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheWritePerMTok: number;
  readonly cacheReadPerMTok: number;
}

/** What a task has spent on its model so far: the row's own column. */
export interface TaskLlmUsage extends LlmUsage {
  readonly model: string;
  /** Calls the API answered. A call that failed cost nothing and is not counted. */
  readonly calls: number;
  /** Rounded to the micro-dollar; the sum of per-call costs, each rounded the same way. */
  readonly costUsd: number;
}

export const ZERO_LLM_USAGE: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

/**
 * ARCHITECTURE §7's list price for claude-opus-5: $5 in, $25 out. Cache
 * writes cost a quarter more than input and reads a tenth of it, the
 * standard ratios. Revisit with a price change, not with eval data.
 */
export const OPUS_5_PRICING: LlmPricing = {
  inputPerMTok: 5,
  outputPerMTok: 25,
  cacheWritePerMTok: 6.25,
  cacheReadPerMTok: 0.5,
};

const MILLION = 1_000_000;

/** Rounds to the micro-dollar, which is finer than any single token's price. */
export function roundUsd(amount: number): number {
  return Math.round(amount * MILLION) / MILLION;
}

export function addLlmUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  };
}

/** Every token the call touched, which is what a token budget counts. */
export function totalLlmTokens(usage: LlmUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
}

export function costOfLlmUsage(usage: LlmUsage, pricing: LlmPricing): number {
  return roundUsd(
    (usage.inputTokens * pricing.inputPerMTok +
      usage.outputTokens * pricing.outputPerMTok +
      usage.cacheCreationInputTokens * pricing.cacheWritePerMTok +
      usage.cacheReadInputTokens * pricing.cacheReadPerMTok) /
      MILLION,
  );
}

/** The task's total after one more answered call. */
export function chargeLlmCall(
  total: TaskLlmUsage,
  call: LlmUsage,
  pricing: LlmPricing,
): TaskLlmUsage {
  return {
    ...addLlmUsage(total, call),
    model: total.model,
    calls: total.calls + 1,
    costUsd: roundUsd(total.costUsd + costOfLlmUsage(call, pricing)),
  };
}

export function emptyTaskLlmUsage(model: string): TaskLlmUsage {
  return { ...ZERO_LLM_USAGE, model, calls: 0, costUsd: 0 };
}
