import Anthropic from '@anthropic-ai/sdk';
import type { LlmUsage } from '@chief-of-staff/core';

import type { ToolDefinition } from './tools.js';

/**
 * One call to the model, and what it comes back as. The loop in `runner.ts`
 * decides when to call and what to do with the answer; this is the shape of
 * the wire and the words for its failures, kept apart so the retry policy
 * can be proven without a browser.
 */

export interface ModelRetryPolicy {
  /** Calls in all, the first included. */
  readonly attempts: number;
  /** The wait before the second call; every later wait doubles it. */
  readonly baseDelayMs: number;
}

export const DEFAULT_MODEL_RETRY: ModelRetryPolicy = { attempts: 4, baseDelayMs: 500 };

/** The wait after the given attempt failed, before the next one. */
export function retryDelayMs(policy: ModelRetryPolicy, attempt: number): number {
  return policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
}

/** The refusal fallback ARCHITECTURE §7 asks for on every Opus 5 call. */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export type ModelMessage = Anthropic.Beta.Messages.BetaMessageParam;
export type ModelContentBlock = Anthropic.Beta.Messages.BetaContentBlockParam;
export type ModelToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;

export interface ModelToolUse {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface ModelCall {
  readonly model: string;
  readonly maxTokens: number;
  readonly system: string;
  readonly tools: readonly ToolDefinition[];
  readonly messages: readonly ModelMessage[];
  /** How long this one call may take on the wire. */
  readonly timeoutMs: number;
}

export interface ModelAnswer {
  readonly kind: 'answered';
  readonly stopReason: string;
  /** The answer as it goes back into the conversation: text and tool uses, nothing the API would refuse to see again. */
  readonly content: readonly ModelContentBlock[];
  readonly toolUses: readonly ModelToolUse[];
  readonly usage: LlmUsage;
}

export interface ModelFailure {
  readonly kind: 'failed';
  /** Whether another call might be answered: an outage, a rate limit, a dropped connection. */
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly message: string;
}

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 409, 429]);

/** What the SDK threw, in the two facts the loop acts on. */
export function classifyModelError(error: unknown): ModelFailure {
  if (error instanceof Anthropic.APIError) {
    const raw: unknown = error.status;
    const status = typeof raw === 'number' ? raw : undefined;
    const retryable = status === undefined || RETRYABLE_STATUSES.has(status) || status >= 500;
    return { kind: 'failed', retryable, status, message: error.message };
  }
  return {
    kind: 'failed',
    retryable: false,
    status: undefined,
    message: error instanceof Error ? error.message : String(error),
  };
}

/** A tool definition as the API takes it. */
export function apiTool(tool: ToolDefinition): Anthropic.Beta.Messages.BetaTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: { ...tool.jsonSchema, type: 'object' },
  };
}

/** The answer's blocks as they may be sent back: text and tool uses, in order. */
export function replayable(content: readonly Anthropic.Beta.Messages.BetaContentBlock[]): ModelContentBlock[] {
  const blocks: ModelContentBlock[] = [];
  for (const block of content) {
    if (block.type === 'text') blocks.push({ type: 'text', text: block.text });
    if (block.type === 'tool_use') blocks.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
  }
  return blocks;
}

function usageOf(usage: Anthropic.Beta.Messages.BetaUsage): LlmUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  };
}

export async function callModel(client: Anthropic, call: ModelCall): Promise<ModelAnswer | ModelFailure> {
  let message: Anthropic.Beta.Messages.BetaMessage;
  try {
    message = await client.beta.messages.create(
      {
        model: call.model,
        max_tokens: call.maxTokens,
        system: [{ type: 'text', text: call.system, cache_control: { type: 'ephemeral' } }],
        tools: call.tools.map(apiTool),
        messages: [...call.messages],
        fallbacks: 'default',
        betas: [FALLBACK_BETA],
      },
      { timeout: call.timeoutMs },
    );
  } catch (error: unknown) {
    return classifyModelError(error);
  }
  const toolUses: ModelToolUse[] = [];
  for (const block of message.content) {
    if (block.type === 'tool_use') toolUses.push({ id: block.id, name: block.name, input: block.input });
  }
  return {
    kind: 'answered',
    stopReason: message.stop_reason ?? 'end_turn',
    content: replayable(message.content),
    toolUses,
    usage: usageOf(message.usage),
  };
}
