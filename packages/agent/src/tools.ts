import type Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { ToolError } from '@anthropic-ai/sdk/lib/tools/ToolError';
import {
  CALENDAR_ITEM_KINDS,
  TASK_KINDS,
  TASK_MODES,
  TIER_POLICIES,
  WATCH_KINDS,
  WATCH_STATUSES,
} from '@chief-of-staff/core';
import * as z from 'zod';

import type { CrudClient, CrudMethod, CrudResponse } from './crud.js';

/**
 * The chat layer's tools, from ARCHITECTURE §6, each one a wrapper over exactly
 * one CRUD call.
 *
 * The wrappers stay deliberately stupid. They do not retry, and they do not
 * soften a refusal: the API server owns validation and ownership, and a second
 * opinion here could only ever disagree with the one that counts. What they add
 * is a budget, and the model's name for the thing.
 *
 * Where the line falls: the schema declares the *shape* a call must have to be
 * well formed at all - which fields, which types, which closed sets - and the
 * server declares every *constraint* on the values. So `kind` is an enum here,
 * because a value outside it is not a call the API has a route for; but `url` is
 * a plain string, because "must be http or https" is the server's rule and the
 * server says it better. A `z.url()` here would refuse first, in different
 * words, against a slightly different rule, and the user would be told the
 * client's opinion of their URL instead of the one that actually decides. The
 * format still reaches the model - in the description, where it belongs.
 */

/**
 * The registered set, in the order the model sees them. `answer_pending` and
 * `connect_site` from §6 are not here: routing a reply to a waiting task is
 * `pending-question-routing`, and a live-login link needs the site connection
 * flow that sprint `site-connections` owns.
 */
export const CHAT_TOOL_NAMES = [
  'create_watch',
  'list_watches',
  'pause_watch',
  'add_calendar_item',
  'list_calendar',
  'create_task',
  'get_task',
] as const;

export type ChatToolName = (typeof CHAT_TOOL_NAMES)[number];

/** One tool the loop actually ran, and what it got back. */
export interface ToolCallRecord {
  readonly name: ChatToolName;
  readonly input: unknown;
  /** Exactly the text the model was shown, refusal or otherwise. */
  readonly result: string;
  readonly ok: boolean;
}

/** Exactly what `toolRunner` accepts, named here without repeating its shape. */
type RunnerTools = Parameters<Anthropic['beta']['messages']['toolRunner']>[0]['tools'];

export interface ChatToolkitOptions {
  readonly crud: CrudClient;
  /** The user every call is made as. One toolkit serves one message. */
  readonly caller: string;
  /** How many calls this message may make before the loop is cut off. */
  readonly budget: number;
}

export interface ChatToolkit {
  readonly tools: RunnerTools;
  /** The calls that ran, oldest first. */
  readonly calls: readonly ToolCallRecord[];
  /** True once a call was turned away for having no budget left. */
  readonly overBudget: boolean;
}

/**
 * A toolkit is built per message rather than per process. The caller's identity
 * is baked into every call it makes, so a shared one would be a way for one
 * chat's tools to act as another chat's user; and the budget is per message by
 * definition.
 */
export function createChatToolkit(options: ChatToolkitOptions): ChatToolkit {
  const { crud, caller, budget } = options;
  const calls: ToolCallRecord[] = [];
  let overBudget = false;

  /**
   * Runs one CRUD call if the message can still afford it. A refusal is thrown
   * as a `ToolError` so the model sees `is_error` and the server's own words,
   * which is the whole of ARCHITECTURE §6's "the LLM's only chat-layer job is
   * natural language → structured call → confirmation": there is nothing here
   * to translate a reason into a worse one.
   */
  async function call(
    name: ChatToolName,
    input: unknown,
    method: CrudMethod,
    path: string,
    body?: unknown,
  ): Promise<string> {
    if (calls.length >= budget) {
      overBudget = true;
      // Nothing is sent. The budget exists to bound the work one message can
      // do, and a call made "just this once" past it is the work it bounds.
      throw new ToolError(
        'You have used every step this message allows. Stop and say what you have done.',
      );
    }
    const response: CrudResponse = await crud.request(caller, method, path, body);
    const result = response.ok ? render(response.body) : response.reason;
    calls.push({ name, input, result, ok: response.ok });
    if (!response.ok) throw new ToolError(result);
    return result;
  }

  const tools: RunnerTools = [
    betaZodTool({
      name: 'create_watch',
      description:
        'Watch a page and notify the user when a condition holds. Use for price drops, ' +
        'appointment slots opening, and any "tell me when this page changes" request.',
      inputSchema: z.object({
        kind: z.enum([...WATCH_KINDS]).describe('price for a price drop, slot for availability, change for anything else'),
        url: z.string().describe('the page to watch, including the https:// on the front'),
        schedule: z.string().describe('a five-field cron expression saying how often to check'),
        condition: z
          .record(z.string(), z.unknown())
          .describe(
            "what makes it worth notifying, in the page's own units: { \"drops_below\": 20 } for a " +
              "price watch on a $20 threshold (rises_above also works), { \"region\": \"the headline\" } " +
              'or {} for a change watch, { "site": "fakedmv", "applicant": { "name": "Ada Lovelace" }, ' +
              '"auto_book": false } for a slot watch (auto_book true books without asking first)',
          ),
        extractor: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('how to read the value out of the page; omit to read the whole page'),
        tierPolicy: z.enum([...TIER_POLICIES]).optional().describe('how hard to work to fetch the page'),
      }),
      run: (input) => call('create_watch', input, 'POST', '/watches', input),
    }),
    betaZodTool({
      name: 'list_watches',
      description: 'Every watch this user has, with its id, url, status and last seen value.',
      inputSchema: z.object({}),
      run: (input) => call('list_watches', input, 'GET', '/watches'),
    }),
    betaZodTool({
      name: 'pause_watch',
      description:
        'Pause or resume one watch. Needs the watch id, so list the watches first ' +
        'unless the user already named one.',
      inputSchema: z.object({
        watchId: z.string().describe('the id from list_watches'),
        status: z.enum([...WATCH_STATUSES]),
      }),
      run: (input) =>
        call('pause_watch', input, 'PATCH', `/watches/${input.watchId}`, { status: input.status }),
    }),
    betaZodTool({
      name: 'add_calendar_item',
      description:
        'Record a subscription that renews or a deadline to act by, so the user is ' +
        'reminded before it lands.',
      inputSchema: z.object({
        kind: z.enum([...CALENDAR_ITEM_KINDS]),
        name: z.string().describe('what the user calls it, e.g. "Southside Gym"'),
        amountCents: z.int().optional().describe('money is always integer cents, never a decimal'),
        renewOn: z.string().optional().describe('YYYY-MM-DD; required for a subscription'),
        cancelBy: z.string().optional().describe('YYYY-MM-DD; required for a deadline'),
        action: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('what to do about it when the date comes'),
      }),
      run: (input) => call('add_calendar_item', input, 'POST', '/calendar-items', input),
    }),
    betaZodTool({
      name: 'list_calendar',
      description:
        'Every subscription and deadline this user has recorded. Read this before ' +
        'acting on a request that names one, so an ambiguous name can be asked about.',
      inputSchema: z.object({}),
      run: (input) => call('list_calendar', input, 'GET', '/calendar-items'),
    }),
    betaZodTool({
      name: 'create_task',
      description:
        'Queue a real-world action - cancelling a subscription, booking a slot. This ' +
        'only queues it: say that it is queued, never that it is done.',
      inputSchema: z.object({
        kind: z.enum([...TASK_KINDS]),
        input: z
          .record(z.string(), z.unknown())
          .describe('everything the action needs, e.g. { "what": "gym", "connection": "fakegym" }'),
        mode: z.enum([...TASK_MODES]).optional().describe('omit unless the user asked for one'),
      }),
      run: (input) => call('create_task', input, 'POST', '/tasks', input),
    }),
    betaZodTool({
      name: 'get_task',
      description: 'What became of one queued task: its status, and its result once it has one.',
      inputSchema: z.object({ taskId: z.string().describe('the id create_task gave back') }),
      run: (input) => call('get_task', input, 'GET', `/tasks/${input.taskId}`),
    }),
  ];

  return {
    tools,
    get calls() {
      return calls;
    },
    get overBudget() {
      return overBudget;
    },
  };
}

/** A body as the model reads it. Strings pass through; everything else is JSON. */
function render(body: unknown): string {
  return typeof body === 'string' ? body : JSON.stringify(body);
}
