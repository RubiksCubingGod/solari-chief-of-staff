import Anthropic from '@anthropic-ai/sdk';

/**
 * A Claude client whose answers are written down in advance.
 *
 * Every proof of the chat loop needs the model to do one exact thing - call
 * this tool with these arguments, then say that - and a real model does not
 * take instructions that precise. So the transport is replaced rather than the
 * loop: `client.beta.messages.toolRunner` runs unmodified, over the real SDK,
 * against canned HTTP responses. What the loop does with a tool call, what it
 * hands back to the model, and how it ends are all genuinely exercised; only
 * the model's judgement is scripted.
 *
 * The one live proof in this package uses the real transport instead, which is
 * what keeps the scripted responses honest about the shape a real one has.
 *
 * Source-only, like the bot's test transport: it is excluded from the package
 * build and from its exports, because a client that answers its own API calls
 * must never be installable in production.
 */

/** One scripted answer from the model. */
export type ScriptedTurn =
  | { readonly kind: 'say'; readonly text: string }
  | { readonly kind: 'call'; readonly text?: string; readonly calls: readonly ScriptedCall[] }
  | { readonly kind: 'outage'; readonly status: number };

export interface ScriptedCall {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

/** The model answers with words and stops. */
export function say(text: string): ScriptedTurn {
  return { kind: 'say', text };
}

/** The model asks for one tool, so the loop runs it and comes back. */
export function useTool(name: string, input: Record<string, unknown>): ScriptedTurn {
  return { kind: 'call', calls: [{ name, input }] };
}

/** Several tools in one turn, which is how a real model batches independent reads. */
export function useTools(...calls: readonly ScriptedCall[]): ScriptedTurn {
  return { kind: 'call', calls };
}

/** Nothing answers: the API is down, or the account is out of credit. */
export function outage(status = 500): ScriptedTurn {
  return { kind: 'outage', status };
}

/** One `/v1/messages` request the loop sent, in the fields a proof asks about. */
export interface ScriptedRequest {
  readonly system: unknown;
  readonly toolNames: readonly string[];
  readonly messages: readonly ScriptedMessage[];
  readonly betas: readonly string[];
  readonly body: Record<string, unknown>;
}

interface ScriptedMessage {
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

export interface ScriptedLlm {
  readonly client: Anthropic;
  /** Every request the loop sent, oldest first. */
  requests(): ScriptedRequest[];
  /**
   * Every tool result the model was shown, oldest first. This is where a
   * passthrough proof looks: a CRUD refusal has only reached the model if its
   * reason is in here, whatever the scripted reply then says.
   */
  toolResults(): ToolResultSeen[];
}

const MODEL = 'claude-opus-5';

export function createScriptedLlm(...script: readonly ScriptedTurn[]): ScriptedLlm {
  const remaining = [...script];
  const requests: ScriptedRequest[] = [];
  let toolUseCounter = 0;

  // Not `async`: every branch already has its answer in hand, and the one that
  // fails must reject the promise rather than throw past the SDK's call site.
  const fetch = (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = parseBody(init?.body);
    requests.push({
      system: body['system'],
      toolNames: asRecords(body['tools']).map((tool) => String(tool['name'])),
      messages: asRecords(body['messages']).map((message) => ({
        role: String(message['role']),
        content: message['content'],
      })),
      betas: asStrings(body['betas']),
      body,
    });

    const turn = remaining.shift();
    if (turn === undefined) {
      // Running off the end of the script means the loop took more turns than
      // the test scripted, which is a finding rather than a default answer.
      return Promise.reject(
        new Error(
          `The scripted model was asked for turn ${String(requests.length)} of ${String(script.length)}.`,
        ),
      );
    }
    if (turn.kind === 'outage') {
      return Promise.resolve(
        jsonResponse(turn.status, {
          type: 'error',
          error: { type: 'api_error', message: 'the scripted outage' },
        }),
      );
    }

    const content: Record<string, unknown>[] = [];
    if (turn.kind === 'say') {
      content.push({ type: 'text', text: turn.text });
    } else {
      if (turn.text !== undefined) content.push({ type: 'text', text: turn.text });
      for (const call of turn.calls) {
        toolUseCounter += 1;
        content.push({
          type: 'tool_use',
          id: `toolu_${String(toolUseCounter)}`,
          name: call.name,
          input: call.input,
        });
      }
    }

    return Promise.resolve(
      jsonResponse(200, {
        id: `msg_${String(requests.length)}`,
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content,
        stop_reason: turn.kind === 'say' ? 'end_turn' : 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  };

  return {
    client: new Anthropic({
      apiKey: 'scripted-key-not-a-real-one',
      // A scripted outage should be answered once, not three times over several
      // seconds of backoff: the loop's behaviour is what is being proved, and
      // the SDK's retry policy is not this package's to assert.
      maxRetries: 0,
      fetch,
    }),
    requests: () => [...requests],
    toolResults: () => collectToolResults(requests),
  };
}

/**
 * Tool results, oldest first, deduplicated by tool-use id. Every request after
 * the first carries the whole history, so the same result appears many times;
 * and a loop that stopped at its iteration cap never sent its last results at
 * all, which is why this reads every request rather than only the last.
 */
function collectToolResults(requests: readonly ScriptedRequest[]): ToolResultSeen[] {
  const names = new Map<string, string>();
  const seen = new Map<string, ToolResultSeen>();
  for (const request of requests) {
    for (const message of request.messages) {
      for (const block of asRecords(message.content)) {
        if (block['type'] === 'tool_use') {
          names.set(String(block['id']), String(block['name']));
        }
        if (block['type'] !== 'tool_result') continue;
        const toolUseId = String(block['tool_use_id']);
        if (seen.has(toolUseId)) continue;
        seen.set(toolUseId, {
          toolUseId,
          name: names.get(toolUseId) ?? '<unknown>',
          content: renderContent(block['content']),
          isError: block['is_error'] === true,
        });
      }
    }
  }
  return [...seen.values()];
}

/** A tool result is a string or a list of blocks; proofs read it as text either way. */
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

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
