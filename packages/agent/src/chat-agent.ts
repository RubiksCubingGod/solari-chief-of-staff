import type Anthropic from '@anthropic-ai/sdk';

import type { CrudClient } from './crud.js';
import {
  LLM_UNAVAILABLE,
  LLM_UNAVAILABLE_MIDWAY,
  NO_REPLY_PRODUCED,
  TOOL_BUDGET_SPENT,
} from './replies.js';
import { createChatToolkit, type ToolCallRecord } from './tools.js';

/**
 * One Telegram message in, one reply and at most a handful of CRUD effects out.
 *
 * The loop itself is the SDK's tool runner, unmodified. What this module adds is
 * the three things a chat front door needs and a raw runner does not have: a
 * bound on how much one message may do, a reply for every way the turn can end
 * without the model producing one, and the guarantee that the tools act as the
 * person who sent the message and nobody else.
 *
 * It knows nothing about Telegram and nothing about the database. Its input is
 * a user id and a string; its output is a string and a record of what happened.
 */

/** How the turn ended. Every value has exactly one reply that goes with it. */
export type ChatTurnOutcome =
  /** The model answered, having done whatever it decided to do. */
  | 'answered'
  /** The model was still working when the budget ran out. */
  | 'over-budget'
  /** Nothing came back from the model at all. */
  | 'unavailable'
  /** The loop finished, and the model had said nothing. */
  | 'no-answer';

export interface ChatTurn {
  /** What to send back. Never empty, whatever happened. */
  readonly reply: string;
  readonly outcome: ChatTurnOutcome;
  /**
   * The CRUD calls that actually ran, in order. This is the honest record of
   * what a turn changed, and it is populated even when the turn then failed -
   * an outage after a watch was created did not un-create the watch.
   */
  readonly toolCalls: readonly ToolCallRecord[];
}

export interface ChatRequest {
  /** The bound user the message came from. Every tool call is made as them. */
  readonly userId: string;
  readonly text: string;
}

export interface ChatAgentOptions {
  readonly client: Anthropic;
  readonly crud: CrudClient;
  readonly model?: string;
  /** How many CRUD calls one message may make. */
  readonly toolBudget?: number;
  readonly maxTokens?: number;
  /** Replaces the prompt below wholesale; the default is the product's. */
  readonly systemPrompt?: string;
}

export interface ChatAgent {
  respond(request: ChatRequest): Promise<ChatTurn>;
}

/** ARCHITECTURE §7: one model everywhere, because the agent loop is the reliability core. */
export const CHAT_MODEL = 'claude-opus-5';

/**
 * Enough for read-then-act-then-confirm with room to look something up first,
 * and far short of a loop that could work through somebody's whole account on
 * one message.
 */
export const DEFAULT_TOOL_BUDGET = 6;

export const CHAT_MAX_TOKENS = 2048;

export const CHAT_SYSTEM_PROMPT = `You are the chat front door of a personal chief of staff, talking to one user over Telegram.

Turn what they say into tool calls, then tell them plainly what you did. You have no other way to affect anything: if no tool fits, say so instead of describing an action you cannot take.

Rules that matter more than being helpful:
- Never guess between two things the user might have meant. Ask which one.
- create_task only queues work. Say it is queued; never say it is done.
- When a tool refuses, tell the user the reason it gave, in your own words. Do not retry the same call unchanged.
- Read before you write when the request names something you have not been given an id for.
- connect_site never takes a password, and neither do you. Relay its editorUrl, profileName and confirmUrl word for word; the user signs in themselves.

Keep replies short enough to read on a phone. No markdown headings, no bullet lists unless you are listing rows the user asked for.`;

export function createChatAgent(options: ChatAgentOptions): ChatAgent {
  const { client, crud } = options;
  const model = options.model ?? CHAT_MODEL;
  const budget = options.toolBudget ?? DEFAULT_TOOL_BUDGET;
  const maxTokens = options.maxTokens ?? CHAT_MAX_TOKENS;
  const systemPrompt = options.systemPrompt ?? CHAT_SYSTEM_PROMPT;

  return {
    async respond(request) {
      // Per message, because the caller identity is baked into every call it
      // makes and the budget means nothing if it is shared.
      const toolkit = createChatToolkit({ crud, caller: request.userId, budget });

      const runner = client.beta.messages.toolRunner({
        model,
        max_tokens: maxTokens,
        // A content block rather than a bare string, so the cache breakpoint
        // can sit after it: the prompt and the tool definitions are byte-stable
        // across every message from every user, and the tool-result turns
        // re-send the whole history, so the hit rate is what makes the loop
        // affordable (ARCHITECTURE §7).
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        tools: toolkit.tools,
        messages: [{ role: 'user', content: request.text }],
        // One more turn than the budget: the last one is the model, having been
        // told it has no calls left, saying what it did. Without the cap a
        // model that keeps calling would keep being refused forever, one paid
        // request at a time.
        max_iterations: budget + 1,
        // ARCHITECTURE §7: a refusal from the primary model is served by the
        // fallback chain rather than becoming a shrug at the user.
        fallbacks: 'default',
        betas: ['server-side-fallback-2026-07-01'],
      });

      let spoken: string;
      try {
        spoken = textOf(await runner.runUntilDone());
      } catch {
        // Deliberately swallowed rather than rethrown. The caller is a Telegram
        // handler with a person waiting on it; what it needs is something to
        // send and an honest record of what already happened, which is exactly
        // what the toolkit still holds.
        //
        // Which apology depends on that record. An outage before anything ran
        // changed nothing; an outage after a tool call left the change in
        // place, and the two cannot honestly be told the same thing.
        return {
          // On effects, not attempts: the record holds refused calls too, and
          // a call the API turned down changed nothing to warn anybody about.
          reply: toolkit.calls.some((call) => call.ok) ? LLM_UNAVAILABLE_MIDWAY : LLM_UNAVAILABLE,
          outcome: 'unavailable',
          toolCalls: toolkit.calls,
        };
      }

      // Checked before the model's own words, because a turn cut off at the
      // budget was cut off mid-thought: whatever text came with that last
      // request was written before the model knew it had been stopped.
      if (toolkit.overBudget) {
        return { reply: TOOL_BUDGET_SPENT, outcome: 'over-budget', toolCalls: toolkit.calls };
      }
      if (spoken === '') {
        return { reply: NO_REPLY_PRODUCED, outcome: 'no-answer', toolCalls: toolkit.calls };
      }
      return { reply: spoken, outcome: 'answered', toolCalls: toolkit.calls };
    },
  };
}

/** Every text block of the final message, joined. Thinking and tool calls are not speech. */
function textOf(message: Anthropic.Beta.Messages.BetaMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}
