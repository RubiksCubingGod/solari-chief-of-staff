import { describe, expect, it } from 'vitest';

import { DEFAULT_AGENTIC_BUDGETS } from './budget.js';
import {
  AGENTIC_SYSTEM_PROMPT,
  NUDGE,
  describeCredential,
  goalFor,
  missionBrief,
  summarizeHistory,
  type BriefEvent,
  type MissionBriefInput,
} from './prompt.js';
import { TOOL_NAMES } from './tools.js';

const step = (name: string, outcome: string, detail: unknown): BriefEvent => ({
  type: 'step',
  payload: { name, outcome, detail },
});

const base: MissionBriefInput = {
  kind: 'cancel',
  input: { url: 'https://gym.example/account' },
  url: 'https://gym.example/account',
  host: 'gym.example',
  credential: undefined,
  answers: [],
  history: [],
  budgets: DEFAULT_AGENTIC_BUDGETS,
};

describe('the system prompt', () => {
  it('names every tool the model can call, so the loop never asks for one the prompt kept quiet about', () => {
    for (const name of TOOL_NAMES) expect(AGENTIC_SYSTEM_PROMPT).toContain(name);
  });

  it('states the rules the code enforces: the host, payments, blocks, and honest outcomes', () => {
    expect(AGENTIC_SYSTEM_PROMPT).toContain('only the host named in the brief');
    expect(AGENTIC_SYSTEM_PROMPT).toContain('never submit a payment');
    expect(AGENTIC_SYSTEM_PROMPT).toContain('status blocked');
    expect(AGENTIC_SYSTEM_PROMPT).toContain('Never report a success you have not seen');
  });

  it('nudges a silent turn towards a tool call', () => {
    expect(NUDGE).toContain('declare_outcome');
  });
});

describe('goalFor', () => {
  it('takes the goal the input states, trimmed', () => {
    expect(goalFor('custom', { goal: '  Renew the parking permit.  ' })).toBe('Renew the parking permit.');
  });

  it('falls back to what the kind of task means when the input states none, or a blank one', () => {
    expect(goalFor('cancel', {})).toContain('Cancel');
    expect(goalFor('book_slot', { goal: '   ' })).toContain('Book');
    expect(goalFor('custom', { goal: 7 })).toBe('Do what the task input describes.');
  });
});

describe('describeCredential', () => {
  it('spells out a password credential, says a profile is already signed in, and admits having none', () => {
    expect(describeCredential({ kind: 'password', username: 'me@example.test', password: 'hunter2' })).toBe(
      "Credentials: sign in with email me@example.test and password hunter2. Enter them only into the site's own sign-in form.",
    );
    expect(describeCredential({ kind: 'profile', profileId: 'p1' })).toContain('saved profile');
    expect(describeCredential(undefined)).toContain('Credentials: none');
  });
});

describe('summarizeHistory', () => {
  it('turns the tool steps of a trail into numbered lines and leaves everything else out', () => {
    const lines = summarizeHistory([
      { type: 'transition', payload: { to: 'started' } },
      step('browser_session', 'ok', { sessionId: 's1' }),
      step('llm', 'ok', { model: 'claude-opus-5' }),
      step('tool:navigate', 'ok', {
        input: { url: 'https://gym.example/account' },
        result: { kind: 'digest', title: 'Account', url: 'https://gym.example/account' },
      }),
      step('tool:type', 'ok', {
        input: { ref: 'e3', text: 'me@example.test' },
        result: { kind: 'field', value: 'me@example.test' },
      }),
      step('tool:click', 'error', { input: { ref: 'e9' }, failure: { kind: 'stale', reason: 'no element e9 on the page' } }),
      step('tool:select', 'error', {
        input: { ref: 'e4', option: 'Gold' },
        failure: { kind: 'invalid', issues: ['option: required'] },
      }),
      step('tool:read', 'error', { input: {}, failure: { kind: 'timeout' } }),
      step('tool:ask_user', 'asked', { input: { question: 'Which plan?' }, question: 'Which plan?' }),
      step('tool:declare_outcome', 'declared', {
        input: { status: 'failed', detail: 'no plan' },
        status: 'failed',
        detail: 'no plan',
      }),
      { type: 'step', payload: 'not a record' },
      { type: 'step', payload: { name: 7 } },
    ]);
    expect(lines).toEqual([
      '1. navigate https://gym.example/account -> ok: Page "Account" at https://gym.example/account',
      '2. type e3 "me@example.test" -> ok: now "me@example.test"',
      '3. click e9 -> error: stale: no element e9 on the page',
      '4. select e4 "Gold" -> error: invalid: option: required',
      '5. read -> error: timeout',
      '6. ask_user -> asked: asked "Which plan?"',
      '7. declare_outcome failed -> declared: declared failed: no plan',
    ]);
  });

  it('keeps the most recent lines when there are more than the limit, and says how many it dropped', () => {
    const events = Array.from({ length: 5 }, (_unused, index) =>
      step('tool:read', 'ok', { input: {}, result: { kind: 'digest', title: `Page ${String(index + 1)}`, url: 'u' } }),
    );
    const lines = summarizeHistory(events, 2);
    expect(lines).toEqual([
      '(3 earlier tool uses omitted)',
      '4. read -> ok: Page "Page 4" at u',
      '5. read -> ok: Page "Page 5" at u',
    ]);
  });
});

describe('missionBrief', () => {
  it('says what, where, as whom, with what input, and within what budget', () => {
    const brief = missionBrief({ ...base, budgets: { maxToolCalls: 40, maxTokens: 400_000, maxWallMs: 600_000 } });
    expect(brief.split('\n')).toEqual([
      'Mission: cancel',
      `Goal: ${goalFor('cancel', {})}`,
      'Start at: https://gym.example/account',
      'Allowed host: gym.example. The guardrails refuse navigation to any other host.',
      describeCredential(undefined),
      'Task input: {"url":"https://gym.example/account"}',
      'Budget: at most 40 tool calls and 400000 tokens, within 600 seconds of wall time.',
    ]);
  });

  it('repeats the answers the person gave and the tool uses before the pause, and asks the model to go on from there', () => {
    const brief = missionBrief({
      ...base,
      answers: [{ question: 'Which plan?', reply: 'Gold' }],
      history: [step('tool:ask_user', 'asked', { input: { question: 'Which plan?' }, question: 'Which plan?' })],
    });
    expect(brief).toContain('The person answered:\n- Q: Which plan?\n  A: Gold');
    expect(brief).toContain('Earlier in this task, the tools were used like this:\n1. ask_user -> asked: asked "Which plan?"');
    expect(brief).toContain('Do not ask a question the person has already answered.');
  });

  it('leaves the answers and the history out when there are none', () => {
    const brief = missionBrief(base);
    expect(brief).not.toContain('The person answered');
    expect(brief).not.toContain('Earlier in this task');
  });
});
