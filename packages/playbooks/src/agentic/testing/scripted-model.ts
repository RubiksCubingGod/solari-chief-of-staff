import Anthropic from '@anthropic-ai/sdk';

/**
 * A model whose judgement is a function the test wrote.
 *
 * The agentic runner is proven against the real SDK over a replaced
 * transport: `/v1/messages` is answered from here with the tool calls the
 * test decided on, given what the loop has sent so far. The loop, the tools
 * on the page, the budgets and the cost accounting all run unmodified; only
 * the model's choices are scripted - and they can be scripted against the
 * page, since a policy sees the digests the loop showed the model and can
 * read a ref off one.
 *
 * Source-only, like the agent package's scripted client: excluded from the
 * package build and its exports, because a client that answers its own API
 * calls must never be installable in production.
 */

/** Tokens as the API reports them, and as a test may set them per call. */
export interface TokenUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly cache_read_input_tokens: number;
}

export const DEFAULT_SCRIPTED_USAGE: TokenUsage = {
  input_tokens: 1_000,
  output_tokens: 50,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

export interface ScriptedCall {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

/** One answer from the model. */
export type ScriptedTurn =
  | { readonly kind: 'say'; readonly text: string }
  | { readonly kind: 'call'; readonly text?: string; readonly calls: readonly ScriptedCall[] }
  | { readonly kind: 'outage'; readonly status: number };

/** The model answers with words and calls nothing. */
export function say(text: string): ScriptedTurn {
  return { kind: 'say', text };
}

/** The model asks for one tool. */
export function useTool(name: string, input: Record<string, unknown>): ScriptedTurn {
  return { kind: 'call', calls: [{ name, input }] };
}

/** Several tools in one turn, the way a real model batches independent actions. */
export function useTools(...calls: readonly ScriptedCall[]): ScriptedTurn {
  return { kind: 'call', calls };
}

/** Nothing answers: the API is down, rate-limiting, or refusing. */
export function outage(status = 500): ScriptedTurn {
  return { kind: 'outage', status };
}

export function declare(status: 'succeeded' | 'failed' | 'blocked', detail: string): ScriptedTurn {
  return useTool('declare_outcome', { status, detail });
}

export function ask(question: string): ScriptedTurn {
  return useTool('ask_user', { question });
}

export interface ScriptedMessage {
  readonly role: string;
  readonly content: unknown;
}

/** One tool result the loop handed back to the model. */
export interface ToolResultSeen {
  readonly toolUseId: string;
  readonly name: string;
  readonly content: string;
  readonly isError: boolean;
}

/** One `/v1/messages` request the loop sent, in the fields a policy or a proof reads. */
export interface ModelRequest {
  /** Which turn of this conversation is being asked for: one more than the assistant messages in it. */
  readonly turn: number;
  readonly system: string;
  readonly toolNames: readonly string[];
  /** The first user message: the mission brief. */
  readonly brief: string;
  readonly messages: readonly ScriptedMessage[];
  /** The tool results in the latest message, if it carries any. */
  readonly lastResults: readonly ToolResultSeen[];
  /** The latest message's text, when it is a plain user text such as a nudge. */
  readonly lastText: string | undefined;
  readonly body: Record<string, unknown>;
}

export type ModelPolicy = (request: ModelRequest) => ScriptedTurn;

/**
 * A policy that answers each request with the next step, in order. A step
 * may be a function of the request, which is how a script reads refs off
 * the page the loop just showed it. A request past the last step is a
 * finding: the loop took more turns than the test scripted.
 */
export function script(...steps: readonly (ScriptedTurn | ModelPolicy)[]): ModelPolicy {
  let next = 0;
  return (request) => {
    const step = steps[next];
    next += 1;
    if (step === undefined) {
      throw new Error(`the script has ${String(steps.length)} turns and was asked for turn ${String(next)}`);
    }
    return typeof step === 'function' ? step(request) : step;
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The ref of the element with this accessible label in the most recent
 * digest the model was shown. Refs are stable across digests of the same
 * page, so the latest mention is the right one.
 */
export function refOf(request: ModelRequest, label: string): string {
  const pattern = new RegExp(`\\[(e[0-9]+)\\] [a-z]+ "${escapeRegExp(label)}"`);
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message === undefined) continue;
    for (const block of asRecords(message.content).reverse()) {
      if (block['type'] !== 'tool_result') continue;
      const match = pattern.exec(renderContent(block['content']));
      const ref = match?.[1];
      if (ref !== undefined) return ref;
    }
  }
  throw new Error(`no element labelled "${label}" in any digest the model was shown`);
}

export interface ScriptedModelOptions {
  /** The usage the nth request (from 1) reports; what it leaves out takes the default. */
  readonly usage?: (request: number) => Partial<TokenUsage>;
  readonly model?: string;
}

export interface ScriptedModel {
  readonly client: Anthropic;
  /** Every request the loop sent, oldest first. */
  requests(): ModelRequest[];
  /** Every tool result the model was shown, oldest first, each once. */
  toolResults(): ToolResultSeen[];
}

export function createScriptedModel(policy: ModelPolicy, options: ScriptedModelOptions = {}): ScriptedModel {
  const requests: ModelRequest[] = [];
  const model = options.model ?? 'claude-opus-5';
  let toolUseCounter = 0;

  const fetch = (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = parseBody(init?.body);
    const messages = asRecords(body['messages']).map((message) => ({
      role: String(message['role']),
      content: message['content'],
    }));
    const latest = messages.at(-1);
    const request: ModelRequest = {
      turn: messages.filter((message) => message.role === 'assistant').length + 1,
      system: renderContent(body['system']),
      toolNames: asRecords(body['tools']).map((tool) => String(tool['name'])),
      brief: renderContent(messages[0]?.content),
      messages,
      lastResults: latest === undefined ? [] : resultsIn(latest, namesIn(messages)),
      lastText: latest?.role === 'user' ? textIn(latest.content) : undefined,
      body,
    };
    requests.push(request);

    let turn: ScriptedTurn;
    try {
      turn = policy(request);
    } catch (error: unknown) {
      return Promise.resolve(
        jsonResponse(400, {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: `scripted model: ${error instanceof Error ? error.message : String(error)}`,
          },
        }),
      );
    }
    if (turn.kind === 'outage') {
      return Promise.resolve(
        jsonResponse(turn.status, { type: 'error', error: { type: 'api_error', message: 'the scripted outage' } }),
      );
    }

    const content: Record<string, unknown>[] = [];
    if (turn.kind === 'say') {
      content.push({ type: 'text', text: turn.text });
    } else {
      if (turn.text !== undefined) content.push({ type: 'text', text: turn.text });
      for (const call of turn.calls) {
        toolUseCounter += 1;
        content.push({ type: 'tool_use', id: `toolu_${String(toolUseCounter)}`, name: call.name, input: call.input });
      }
    }
    const usage: TokenUsage = { ...DEFAULT_SCRIPTED_USAGE, ...options.usage?.(requests.length) };
    return Promise.resolve(
      jsonResponse(200, {
        id: `msg_${String(requests.length)}`,
        type: 'message',
        role: 'assistant',
        model,
        content,
        stop_reason: turn.kind === 'say' ? 'end_turn' : 'tool_use',
        stop_sequence: null,
        usage,
      }),
    );
  };

  return {
    client: new Anthropic({
      apiKey: 'scripted-key-not-a-real-one',
      // The runner's own retry policy is what is being proved; the SDK's would
      // answer a scripted outage several times over several seconds of backoff.
      maxRetries: 0,
      fetch,
    }),
    requests: () => [...requests],
    toolResults: () => {
      const names = namesIn(requests.flatMap((request) => request.messages));
      const seen = new Map<string, ToolResultSeen>();
      for (const request of requests) {
        for (const message of request.messages) {
          for (const result of resultsIn(message, names)) {
            if (!seen.has(result.toolUseId)) seen.set(result.toolUseId, result);
          }
        }
      }
      return [...seen.values()];
    },
  };
}

/** Tool names by tool-use id, from every assistant message given. */
function namesIn(messages: readonly ScriptedMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const block of asRecords(message.content)) {
      if (block['type'] === 'tool_use') names.set(String(block['id']), String(block['name']));
    }
  }
  return names;
}

function resultsIn(message: ScriptedMessage, names: Map<string, string>): ToolResultSeen[] {
  return asRecords(message.content)
    .filter((block) => block['type'] === 'tool_result')
    .map((block) => {
      const toolUseId = String(block['tool_use_id']);
      return {
        toolUseId,
        name: names.get(toolUseId) ?? '<unknown>',
        content: renderContent(block['content']),
        isError: block['is_error'] === true,
      };
    });
}

function textIn(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  const texts = asRecords(content).filter((block) => block['type'] === 'text');
  const last = texts.at(-1);
  return last === undefined ? undefined : String(last['text']);
}

/** Content is a string or a list of blocks; policies and proofs read it as text either way. */
function renderContent(content: unknown): string {
  if (typeof content === 'string') return content;
  return asRecords(content)
    .map((block) => (typeof block['text'] === 'string' ? block['text'] : JSON.stringify(block)))
    .join('\n');
}

function parseBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'string') return {};
  const parsed: unknown = JSON.parse(body);
  return isRecord(parsed) ? parsed : {};
}

function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
