import { createApp } from '@chief-of-staff/api';
import { calendarItems, runMigrations, tasks, users, watches } from '@chief-of-staff/db';
import { startTestPostgres, type TestPostgres } from '@chief-of-staff/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createChatAgent, type ChatAgent } from './chat-agent.js';
import { createHttpCrudClient, type CrudClient } from './crud.js';
import { LLM_UNAVAILABLE, TOOL_BUDGET_SPENT } from './replies.js';
import { CHAT_TOOL_NAMES } from './tools.js';
import {
  createScriptedLlm,
  outage,
  say,
  useTool,
  type ScriptedLlm,
  type ScriptedTurn,
} from './testing/scripted-llm.js';

/**
 * The chat command path from the loop inwards: a scripted model, the real
 * Anthropic tool runner, the real HTTP tools, the real API server and a real
 * database. Everything between "the model decided" and "the row exists" is the
 * production path; only the model's judgement is written down in advance.
 *
 * Every accepted case is checked through the API rather than through the tool's
 * own return value, because a tool that reported success without writing
 * anything would pass the weaker assertion. Every refused case is checked for
 * what it did *not* do, because a refusal that still wrote a row is not a
 * refusal.
 */

let postgres: TestPostgres;
// Taken from the factory rather than imported: Fastify is the API package's
// dependency, and this package is only ever a client of the server it starts.
let app: ReturnType<typeof createApp>;
let crud: CrudClient;
let ownerId: string;
let strangerId: string;

const A_WATCH = {
  kind: 'price',
  url: 'https://shop.test/item/1',
  schedule: '0 * * * *',
  condition: { drops_below: 2000 },
} as const;

async function createUser(): Promise<string> {
  const [created] = await app.db.insert(users).values({}).returning();
  if (created === undefined) throw new Error('the fixture user was not created');
  return created.id;
}

beforeAll(async () => {
  postgres = await startTestPostgres();
  await runMigrations(postgres.connectionString);
  app = createApp({ DATABASE_URL: postgres.connectionString, LOG_LEVEL: 'silent' });
  // On a real socket rather than through `inject`: the tools are an HTTP client,
  // and a proof that skipped the transport would not exercise the one the bot
  // actually ships with.
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  crud = createHttpCrudClient({ baseUrl });
  ownerId = await createUser();
  strangerId = await createUser();
});

afterAll(async () => {
  try {
    await app.close();
  } finally {
    await postgres.stop();
  }
});

beforeEach(async () => {
  await app.db.delete(watches);
  await app.db.delete(calendarItems);
  await app.db.delete(tasks);
});

/** The agent under test, with a budget small enough to spend inside a proof. */
function agentFor(llm: ScriptedLlm, toolBudget = 4): ChatAgent {
  return createChatAgent({ client: llm.client, crud, toolBudget });
}

function scripted(...script: readonly ScriptedTurn[]): {
  llm: ScriptedLlm;
  agent: ChatAgent;
} {
  const llm = createScriptedLlm(...script);
  return { llm, agent: agentFor(llm) };
}

/** What the API says the user has, read back the way the dashboard would. */
async function listAs(userId: string, path: string): Promise<unknown[]> {
  const response = await app.inject({ method: 'GET', url: path, headers: { 'x-user-id': userId } });
  return response.json<unknown[]>();
}

async function seedWatch(userId: string, url: string): Promise<string> {
  const [created] = await app.db
    .insert(watches)
    .values({ ...A_WATCH, url, userId, extractor: {} })
    .returning();
  if (created === undefined) throw new Error('the fixture watch was not created');
  return created.id;
}

describe('an order the loop can carry out', () => {
  it('creates a watch that the API can then see, owned by the person who asked', async () => {
    const { llm, agent } = scripted(
      useTool('create_watch', A_WATCH),
      say('Watching that one - I will tell you if it drops under $20.'),
    );

    const turn = await agent.respond({ userId: ownerId, text: 'watch this and tell me under $20' });

    expect(turn.outcome).toBe('answered');
    expect(turn.reply).toBe('Watching that one - I will tell you if it drops under $20.');
    expect(turn.toolCalls.map((call) => call.name)).toEqual(['create_watch']);

    expect(await listAs(ownerId, '/watches')).toMatchObject([
      { userId: ownerId, kind: 'price', url: A_WATCH.url, status: 'active' },
    ]);
    // The caller header the tools send is the user the message came from, so a
    // watch one person asked for is not another person's watch.
    expect(await listAs(strangerId, '/watches')).toEqual([]);
    expect(llm.requests()).toHaveLength(2);
  });

  it('lists the watches somebody actually has, and shows them to the model', async () => {
    await seedWatch(ownerId, 'https://shop.test/kettle');
    await seedWatch(strangerId, 'https://shop.test/not-yours');

    const { llm, agent } = scripted(
      useTool('list_watches', {}),
      say('You have one: the kettle.'),
    );

    const turn = await agent.respond({ userId: ownerId, text: 'what am I watching?' });

    expect(turn.outcome).toBe('answered');
    const [result] = llm.toolResults();
    expect(result?.name).toBe('list_watches');
    expect(result?.isError).toBe(false);
    expect(result?.content).toContain('https://shop.test/kettle');
    expect(result?.content).not.toContain('not-yours');
  });

  it('pauses a watch, and the pause is visible through the API', async () => {
    const watchId = await seedWatch(ownerId, 'https://shop.test/kettle');

    const { agent } = scripted(
      useTool('pause_watch', { watchId, status: 'paused' }),
      say('Paused.'),
    );

    const turn = await agent.respond({ userId: ownerId, text: 'pause the kettle one' });

    expect(turn.outcome).toBe('answered');
    expect(await listAs(ownerId, '/watches')).toMatchObject([{ id: watchId, status: 'paused' }]);
  });

  it('lands a queued task row for a cancellation, and tells the model it is only queued', async () => {
    const { llm, agent } = scripted(
      useTool('create_task', { kind: 'cancel', input: { what: 'gym' } }),
      say('I have queued the cancellation.'),
    );

    const turn = await agent.respond({ userId: ownerId, text: 'cancel my gym' });

    expect(turn.outcome).toBe('answered');
    expect(await listAs(ownerId, '/tasks')).toMatchObject([
      { userId: ownerId, kind: 'cancel', input: { what: 'gym' }, status: 'queued', mode: 'playbook' },
    ]);
    // The reply says "queued" because the tool told the model so. Asserting the
    // scripted words alone would prove nothing about what a real model is given
    // to say: the queued status has to be in the tool result.
    expect(llm.toolResults()[0]?.content).toContain('queued');
    expect(turn.reply).toBe('I have queued the cancellation.');
  });
});

describe('an order the loop should not carry out', () => {
  it('asks which one rather than guessing, and changes nothing while it asks', async () => {
    await app.db.insert(calendarItems).values([
      { userId: ownerId, kind: 'subscription', name: 'Gym - Southside', renewOn: '2026-10-01' },
      { userId: ownerId, kind: 'subscription', name: 'Gym - Riverside', renewOn: '2026-10-02' },
    ]);

    const { llm, agent } = scripted(
      useTool('list_calendar', {}),
      say('You have two gyms - Southside and Riverside. Which should I cancel?'),
    );

    const turn = await agent.respond({ userId: ownerId, text: 'cancel my gym' });

    expect(turn.outcome).toBe('answered');
    expect(turn.reply).toContain('Which should I cancel?');
    // The question was asked because both were in front of the model, and asking
    // it cost nothing: no task was queued on a guess.
    const [result] = llm.toolResults();
    expect(result?.content).toContain('Gym - Southside');
    expect(result?.content).toContain('Gym - Riverside');
    expect(await listAs(ownerId, '/tasks')).toEqual([]);
  });

  it('stops at its budget, says so, and leaves the calls past it unmade', async () => {
    const budget = 2;
    const llm = createScriptedLlm(
      useTool('list_watches', {}),
      useTool('list_watches', {}),
      useTool('list_watches', {}),
      useTool('list_watches', {}),
    );
    const agent = agentFor(llm, budget);

    const turn = await agent.respond({ userId: ownerId, text: 'keep looking' });

    expect(turn.outcome).toBe('over-budget');
    expect(turn.reply).toBe(TOOL_BUDGET_SPENT);
    // Exactly the budget reached the API, and the refusal is the loop's own -
    // the model was still asking when it was cut off.
    expect(turn.toolCalls).toHaveLength(budget);
    expect(llm.requests().length).toBeGreaterThan(budget);
    expect(await listAs(ownerId, '/watches')).toEqual([]);
  });

  it('says it cannot do a thing rather than inventing an action for it', async () => {
    const { llm, agent } = scripted(
      say('I cannot book you a flight - I only handle watches, your calendar and cancellations.'),
    );

    const turn = await agent.respond({ userId: ownerId, text: 'book me a flight to Lisbon' });

    expect(turn.outcome).toBe('answered');
    expect(turn.reply).toContain('I cannot book you a flight');
    expect(turn.toolCalls).toEqual([]);
    expect(llm.toolResults()).toEqual([]);
    expect(await listAs(ownerId, '/watches')).toEqual([]);
    expect(await listAs(ownerId, '/tasks')).toEqual([]);
  });

  it('never runs a tool outside the set it was given', async () => {
    const { llm, agent } = scripted(
      useTool('delete_everything', { confirm: true }),
      say('I could not do that.'),
    );

    const turn = await agent.respond({ userId: ownerId, text: 'wipe my account' });

    expect(llm.requests()[0]?.toolNames).toEqual([...CHAT_TOOL_NAMES]);
    const [result] = llm.toolResults();
    expect(result?.isError).toBe(true);
    // Nothing was spent on it either: a name the loop does not know never
    // reaches the budget, let alone the API.
    expect(turn.toolCalls).toEqual([]);
    expect(await listAs(ownerId, '/watches')).toEqual([]);
  });
});

describe('a refusal that came from somewhere else', () => {
  it('hands the API validation reason to the model instead of a generic failure', async () => {
    const { llm, agent } = scripted(
      useTool('create_watch', {
        kind: 'price',
        url: 'shop.test/item/1',
        schedule: 'every other friday',
        condition: { drops_below: 2000 },
      }),
      say('That URL needs the https:// on the front, and I need a real schedule.'),
    );

    const turn = await agent.respond({ userId: ownerId, text: 'watch shop.test/item/1 weekly' });

    expect(turn.outcome).toBe('answered');
    const [result] = llm.toolResults();
    expect(result?.isError).toBe(true);
    // The fields the API named, named to the model. A generic "the call failed"
    // is what this assertion exists to catch.
    expect(result?.content).toContain('/url');
    expect(result?.content).toContain('/schedule');
    expect(turn.toolCalls[0]?.result).toBe(result?.content);
    expect(await listAs(ownerId, '/watches')).toEqual([]);
  });

  it('apologises and changes nothing when the model itself is unreachable', async () => {
    const { llm, agent } = scripted(outage());

    const turn = await agent.respond({ userId: ownerId, text: 'watch this for me' });

    expect(turn.outcome).toBe('unavailable');
    expect(turn.reply).toBe(LLM_UNAVAILABLE);
    expect(turn.toolCalls).toEqual([]);
    expect(llm.requests()).toHaveLength(1);
    expect(await listAs(ownerId, '/watches')).toEqual([]);
  });

  it('does not lose the effects of a turn the model then died in the middle of', async () => {
    const { agent } = scripted(useTool('create_watch', A_WATCH), outage());

    const turn = await agent.respond({ userId: ownerId, text: 'watch this for me' });

    expect(turn.outcome).toBe('unavailable');
    expect(turn.reply).toBe(LLM_UNAVAILABLE);
    // The watch was created before the outage, and it stays created: the reply
    // is an apology for the missing confirmation, not a claim that nothing
    // happened. The tool calls carry what did.
    expect(turn.toolCalls.map((call) => call.name)).toEqual(['create_watch']);
    expect(await listAs(ownerId, '/watches')).toHaveLength(1);
  });
});
