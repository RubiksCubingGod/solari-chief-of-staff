import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import { createChatAgent } from './chat-agent.js';
import type { CrudClient, CrudResponse } from './crud.js';
import { ANTHROPIC_KEY_VARIABLE, liveLlmSkipReason } from './live-llm.js';

/**
 * The one test here that talks to a real model.
 *
 * Every other proof in this package scripts the model's judgement, which is the
 * only way to pin a loop's behaviour - and which means none of them can fail
 * when the judgement is the thing that is wrong. A tool description the model
 * reads differently than we meant, a field it fills with prose where the schema
 * wants a number, a phrasing it maps to no tool at all: all of those pass every
 * scripted test in this file's neighbourhood and break the product.
 *
 * So it asks in words nobody wrote a schema for - no "create a watch", no field
 * names, a currency the schema does not mention - and checks that what comes
 * back is the right call with the right arguments.
 *
 * It sits in the ordinary `integration` project rather than behind a config
 * exclusion, so the ordinary gate still loads, typechecks and lints it. The
 * guard below is what stops it spending anything.
 */

const skipReason = liveLlmSkipReason(process.env);

/** The reason rides in the suite name, so an ordinary run reports why it skipped. */
const suiteName =
  skipReason === undefined
    ? 'the live chat loop @live-llm'
    : `the live chat loop @live-llm — ${skipReason}`;

/** A real model turn, plus the tool round trip it makes. */
const LIVE_TIMEOUT_MS = 120_000;

const WATCH_URL = 'https://shop.example.com/kettles/9f2';

/**
 * The API, stubbed. What is under test is the mapping from a sentence to a
 * call, and a live model is expensive enough that a proof of it should not also
 * be waiting on a database. The rows it answers with are shaped like the real
 * ones so the model has something plausible to confirm from.
 */
function stubCrud(recorded: { method: string; path: string; body: unknown }[]): CrudClient {
  return {
    request(_caller, method, path, body): Promise<CrudResponse> {
      recorded.push({ method, path, body });
      const created = {
        id: '00000000-0000-4000-8000-000000000001',
        url: WATCH_URL,
        status: 'active',
      };
      return Promise.resolve({ ok: true, status: 201, body: method === 'GET' ? [] : created });
    },
  };
}

describe.skipIf(skipReason !== undefined)(suiteName, () => {
  it(
    'turns a phrasing nobody wrote a schema for into the right tool call',
    async () => {
      const recorded: { method: string; path: string; body: unknown }[] = [];
      const agent = createChatAgent({
        client: new Anthropic({ apiKey: process.env[ANTHROPIC_KEY_VARIABLE] ?? '' }),
        crud: stubCrud(recorded),
        toolBudget: 2,
      });

      const turn = await agent.respond({
        userId: '00000000-0000-4000-8000-0000000000aa',
        // Deliberately none of the vocabulary the tools use: no "watch", no
        // "condition", no "cents", and a price written the way a person writes
        // one. Mapping this is the job the model is here to do.
        text: `keep an eye on ${WATCH_URL} for me and give me a shout if it ever drops below £20 — check it a few times a day`,
      });

      expect(turn.outcome).toBe('answered');
      expect(turn.toolCalls.map((call) => call.name)).toContain('create_watch');

      const [created] = recorded.filter((call) => call.path === '/watches');
      expect(created?.method).toBe('POST');
      const body = created?.body as
        | { url?: unknown; kind?: unknown; schedule?: unknown; condition?: unknown }
        | undefined;
      // The URL it was given, not one it invented, and the kind that matches
      // what was asked for.
      expect(body?.url).toBe(WATCH_URL);
      expect(body?.kind).toBe('price');
      // A five-field cron expression, which is the one part of the request that
      // was given in words ("a few times a day") and has to come back as syntax.
      expect(String(body?.schedule).trim().split(/\s+/u)).toHaveLength(5);
      expect(body?.condition).toBeTypeOf('object');

      // And it reported back rather than going quiet.
      expect(turn.reply.length).toBeGreaterThan(0);
    },
    LIVE_TIMEOUT_MS,
  );
});
