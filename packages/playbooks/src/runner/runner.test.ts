import type { StepEventPayload } from '@chief-of-staff/core';
import type { MissionOutcome, SiteConnection, Task, TaskAnswer } from '@chief-of-staff/db';
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';

import { stopOutcome, type GuardStop } from '../guardrails/index.js';
import { definePlaybook, type Playbook, type PlaybookContext, type PlaybookStep } from './playbook.js';
import { createPlaybookRegistry } from './registry.js';
import { answerTo, choosePlaybook, profileCredentials, runSteps } from './runner.js';

const NOW = new Date('2026-09-02T10:00:00Z');

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    userId: 'user-1',
    kind: 'cancel',
    input: { site: 'fakegym' },
    status: 'queued',
    mode: 'playbook',
    playbookId: null,
    solariSessionId: null,
    recordingUrl: null,
    jobId: null,
    result: null,
    llmUsage: null,
    createdAt: NOW,
    finishedAt: null,
    ...overrides,
  };
}

const connection: SiteConnection = {
  id: 'connection-1',
  userId: 'user-1',
  siteDomain: 'gym.example.test',
  solariProfileId: 'profile-9',
  status: 'connected',
  lastUsedAt: null,
};

/** No step here touches the page: the runner's job is everything around the steps. */
const page = {} as Page;

function step(name: string, run: PlaybookStep['run']): PlaybookStep {
  return { name, run };
}

const done = (name: string, detail?: unknown): PlaybookStep =>
  step(name, () => Promise.resolve(detail === undefined ? { kind: 'done' } : { kind: 'done', detail }));

function playbook(steps: readonly PlaybookStep[]): Playbook {
  return definePlaybook({ site: 'fakegym', action: 'cancel', origin: 'https://gym.example.test', steps });
}

function context(answers: readonly TaskAnswer[] = []): PlaybookContext {
  return {
    task: task(),
    input: { site: 'fakegym' },
    connection,
    credential: { kind: 'profile', profileId: 'profile-9' },
    answers,
    answerTo: (question) => answerTo(answers, question),
  };
}

interface Guard {
  stop: GuardStop | undefined;
}

const VIOLATION: GuardStop = {
  kind: 'allowlist',
  attemptedUrl: 'https://elsewhere.test/away',
  via: 'navigation',
  redirectedFrom: undefined,
  from: 'https://gym.example.test/',
  reason: 'host',
};

interface Drive {
  readonly outcome: MissionOutcome;
  readonly trail: StepEventPayload[];
}

/** Runs the steps with a trail that keeps every payload. */
async function drive(
  steps: readonly PlaybookStep[],
  guard: Guard = { stop: undefined },
  answers: readonly TaskAnswer[] = [],
): Promise<Drive> {
  const trail: StepEventPayload[] = [];
  const outcome = await runSteps(playbook(steps), page, context(answers), guard, (payload) => {
    trail.push(payload);
    return Promise.resolve();
  });
  return { outcome, trail };
}

const answered = (questionId: string, question: string, reply: string): TaskAnswer => ({
  questionId,
  question,
  reply,
  answeredAt: '2026-09-02T10:01:00.000Z',
});

describe('runSteps', () => {
  it('runs the steps in order, writing each outcome before the next step starts, and succeeds with what they returned', async () => {
    const trail: StepEventPayload[] = [];
    const writtenWhenStarted: number[] = [];
    const steps = [
      step('login', () => {
        writtenWhenStarted.push(trail.length);
        return Promise.resolve({ kind: 'done' });
      }),
      step('cancel', () => {
        writtenWhenStarted.push(trail.length);
        return Promise.resolve({ kind: 'done', detail: { cancelled: true } });
      }),
    ];
    const outcome = await runSteps(playbook(steps), page, context(), { stop: undefined }, (payload) => {
      trail.push(payload);
      return Promise.resolve();
    });
    expect(outcome).toEqual({
      kind: 'succeeded',
      result: { playbook: 'fakegym.cancel', steps: [{ name: 'login' }, { name: 'cancel', detail: { cancelled: true } }] },
    });
    expect(trail).toEqual([
      { name: 'login', outcome: 'done' },
      { name: 'cancel', outcome: 'done', detail: { cancelled: true } },
    ]);
    expect(writtenWhenStarted).toEqual([0, 1]);
  });

  it('parks on a step that asks, with the question on the trail, and runs nothing after it', async () => {
    let ran = false;
    const { outcome, trail } = await drive([
      done('login'),
      step('code', () => Promise.resolve({ kind: 'ask', question: 'Which code?' })),
      step('finish', () => {
        ran = true;
        return Promise.resolve({ kind: 'done' });
      }),
    ]);
    expect(outcome).toEqual({ kind: 'ask', question: 'Which code?' });
    expect(trail).toEqual([
      { name: 'login', outcome: 'done' },
      { name: 'code', outcome: 'ask', detail: { question: 'Which code?' } },
    ]);
    expect(ran).toBe(false);
  });

  it('fails on a step that fails, naming the step and keeping its detail, and runs nothing after it', async () => {
    let ran = false;
    const { outcome, trail } = await drive([
      done('login'),
      step('cancel', () => Promise.resolve({ kind: 'failed', reason: 'retention held', detail: { offer: '20% off' } })),
      step('finish', () => {
        ran = true;
        return Promise.resolve({ kind: 'done' });
      }),
    ]);
    expect(outcome).toEqual({ kind: 'failed', reason: 'cancel: retention held', detail: { offer: '20% off' } });
    expect(trail.at(-1)).toEqual({
      name: 'cancel',
      outcome: 'failed',
      detail: { reason: 'retention held', detail: { offer: '20% off' } },
    });
    expect(ran).toBe(false);
  });

  it('fails by refused on a step that refuses, naming the step and keeping its detail, and runs nothing after it', async () => {
    let ran = false;
    const { outcome, trail } = await drive([
      done('availability'),
      step('confirm', () =>
        Promise.resolve({ kind: 'refused', reason: 'the person said no', detail: { code: 'not-confirmed' } }),
      ),
      step('book', () => {
        ran = true;
        return Promise.resolve({ kind: 'done' });
      }),
    ]);
    expect(outcome).toEqual({
      kind: 'failed',
      cause: 'refused',
      reason: 'confirm: the person said no',
      detail: { code: 'not-confirmed' },
    });
    expect(trail.at(-1)).toEqual({
      name: 'confirm',
      outcome: 'refused',
      detail: { reason: 'the person said no', detail: { code: 'not-confirmed' } },
    });
    expect(ran).toBe(false);
  });

  it('fails by refused without detail when the refusing step gave none', async () => {
    const { outcome, trail } = await drive([step('confirm', () => Promise.resolve({ kind: 'refused', reason: 'no' }))]);
    expect(outcome).toEqual({ kind: 'failed', cause: 'refused', reason: 'confirm: no' });
    expect(trail).toEqual([{ name: 'confirm', outcome: 'refused', detail: { reason: 'no' } }]);
  });

  it("folds what done steps hand back for the result into it, under the runner's own fields", async () => {
    const { outcome } = await drive([
      step('availability', () => Promise.resolve({ kind: 'done', detail: { slot: 'Tue' } })),
      step('book', () => Promise.resolve({ kind: 'done', result: { reference: 'DMV-000001', playbook: 'not-this' } })),
      step('after', () => Promise.resolve({ kind: 'done', result: { bookedAt: '2026-09-02T10:00:00.000Z' } })),
    ]);
    expect(outcome).toEqual({
      kind: 'succeeded',
      result: {
        playbook: 'fakegym.cancel',
        steps: [{ name: 'availability', detail: { slot: 'Tue' } }, { name: 'book' }, { name: 'after' }],
        reference: 'DMV-000001',
        bookedAt: '2026-09-02T10:00:00.000Z',
      },
    });
  });

  it('fails on a step that throws, with the message as the reason and no detail', async () => {
    const { outcome, trail } = await drive([step('cancel', () => Promise.reject(new Error('the page fell over')))]);
    expect(outcome).toEqual({ kind: 'failed', reason: 'cancel: the page fell over' });
    expect(trail).toEqual([{ name: 'cancel', outcome: 'failed', detail: { reason: 'the page fell over' } }]);
  });

  it('lets a stop already on the guard win before the first step, writing nothing', async () => {
    let ran = false;
    const { outcome, trail } = await drive(
      [
        step('login', () => {
          ran = true;
          return Promise.resolve({ kind: 'done' });
        }),
      ],
      { stop: VIOLATION },
    );
    expect(outcome).toEqual(stopOutcome(VIOLATION));
    expect(trail).toEqual([]);
    expect(ran).toBe(false);
  });

  it("lets a stop that lands during a step win over that step's outcome, and keeps it off the trail", async () => {
    const guard: Guard = { stop: undefined };
    let ran = false;
    const { outcome, trail } = await drive(
      [
        done('login'),
        step('wander', () => {
          guard.stop = VIOLATION;
          return Promise.resolve({ kind: 'done', detail: { reached: 'elsewhere' } });
        }),
        step('finish', () => {
          ran = true;
          return Promise.resolve({ kind: 'done' });
        }),
      ],
      guard,
    );
    expect(outcome).toEqual(stopOutcome(VIOLATION));
    expect(trail).toEqual([{ name: 'login', outcome: 'done' }]);
    expect(ran).toBe(false);
  });

  it('hands every step the context, and the answers through it', async () => {
    const { outcome } = await drive(
      [
        step('code', (_page, { answerTo: reply, credential, connection: seen }) =>
          Promise.resolve({
            kind: 'done',
            detail: { code: reply('Which code?'), credential, domain: seen?.siteDomain },
          }),
        ),
      ],
      { stop: undefined },
      [answered('q1', 'Which code?', '1234')],
    );
    expect(outcome).toEqual({
      kind: 'succeeded',
      result: {
        playbook: 'fakegym.cancel',
        steps: [
          {
            name: 'code',
            detail: {
              code: '1234',
              credential: { kind: 'profile', profileId: 'profile-9' },
              domain: 'gym.example.test',
            },
          },
        ],
      },
    });
  });
});

describe('definePlaybook', () => {
  it('signs in by default, and says so on the playbook', () => {
    expect(playbook([done('login')]).access).toBe('connection');
  });

  it('is open when the definition says so', () => {
    const open = definePlaybook({
      site: 'fakedmv',
      action: 'book_slot',
      origin: 'http://127.0.0.1:4304',
      access: 'open',
      steps: [done('availability')],
    });
    expect(open).toMatchObject({ id: 'fakedmv.book_slot', access: 'open', siteDomain: '127.0.0.1:4304', allowlist: ['127.0.0.1'] });
  });
});

describe('choosePlaybook', () => {
  const registry = createPlaybookRegistry([playbook([done('login')])]);

  const refused: [string, Partial<Task>, string][] = [
    ['agentic mode', { mode: 'agentic' }, 'agentic mode has no runner yet'],
    ['an input that is a list', { input: ['fakegym'] }, 'the task input is not an object'],
    ['an input that is null', { input: null }, 'the task input is not an object'],
    ['an input that names no site', { input: { plan: 'gold' } }, 'the task input names no site'],
    ['an input whose site is blank', { input: { site: '  ' } }, 'the task input names no site'],
    ['a site no playbook knows', { input: { site: 'nowhere' } }, 'no playbook for cancel on nowhere'],
    ['an action the site has no playbook for', { kind: 'book_slot' }, 'no playbook for book_slot on fakegym'],
  ];

  it.each(refused)('refuses %s in a sentence', (_named, overrides, reason) => {
    expect(choosePlaybook(registry, task(overrides))).toEqual({ kind: 'refused', reason });
  });

  it('chooses the playbook for the site the input names and the kind of task, with the input as a record', () => {
    const choice = choosePlaybook(registry, task({ input: { site: 'fakegym', plan: 'gold' } }));
    expect(choice.kind).toBe('chosen');
    if (choice.kind !== 'chosen') return;
    expect(choice.playbook.id).toBe('fakegym.cancel');
    expect(choice.input).toEqual({ site: 'fakegym', plan: 'gold' });
  });
});

describe('answerTo', () => {
  const answers = [
    answered('q1', 'Which code?', '1111'),
    answered('q2', 'Which slot?', 'noon'),
    answered('q3', 'Which code?', '2222'),
  ];

  it('gives the latest reply to exactly that question', () => {
    expect(answerTo(answers, 'Which code?')).toBe('2222');
    expect(answerTo(answers, 'Which slot?')).toBe('noon');
  });

  it('gives nothing for a question nobody has answered', () => {
    expect(answerTo(answers, 'Which gym?')).toBeUndefined();
    expect(answerTo(answers, 'which code?')).toBeUndefined();
    expect(answerTo([], 'Which code?')).toBeUndefined();
  });
});

describe('profileCredentials', () => {
  it("yields the connection's profile and nothing else", async () => {
    await expect(profileCredentials(connection, task())).resolves.toEqual({
      kind: 'profile',
      profileId: 'profile-9',
    });
  });
});
