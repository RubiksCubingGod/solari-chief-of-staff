import type { StepEventPayload } from '@chief-of-staff/core';
import {
  readSiteConnection,
  recordBrowserSession,
  recordPlaybook,
  type Mission,
  type MissionOutcome,
  type SiteConnection,
  type Task,
  type TaskAnswer,
  type TaskDatabase,
} from '@chief-of-staff/db';
import type { BrowserProvider, BrowserRequest } from '@chief-of-staff/solari';
import type { Page } from 'playwright';

import {
  guardedSession,
  paymentConfirmations,
  stopOutcome,
  type Guardrails,
} from '../guardrails/index.js';
import type { Playbook, PlaybookContext, PlaybookStep, SiteCredential, StepOutcome } from './playbook.js';
import type { PlaybookRegistry } from './registry.js';

/**
 * The runner: the mission every playbook-mode task goes through. It picks the
 * playbook by what the task names, loads the person's connection to that
 * site, opens one guarded session with a recording asked for, writes the
 * session to the row, and runs the steps in order until one asks, one fails,
 * the guard stops the session, or the last one is done. What it hands back
 * is the state machine's own vocabulary, so the engine settles the task
 * without knowing a playbook exists.
 */

/** What a connection yields for the login step. */
export type CredentialSource = (
  connection: SiteConnection,
  task: Task,
) => Promise<SiteCredential | undefined>;

/**
 * The production source: the profile the connection names. The cookies are in
 * the provider's profile store; nothing here is a password, and nothing in
 * the database is one either.
 */
export const profileCredentials: CredentialSource = (connection) =>
  Promise.resolve({ kind: 'profile', profileId: connection.solariProfileId });

export interface PlaybookRunnerOptions {
  readonly db: TaskDatabase;
  readonly provider: BrowserProvider;
  readonly registry: PlaybookRegistry;
  /** What a connection yields for the login step. The connection's profile unless told otherwise. */
  readonly credentials?: CredentialSource;
  /** Asked of every session, under the runner's own asks: the recording, and the profile. */
  readonly request?: BrowserRequest;
}

export type PlaybookChoice =
  | {
      readonly kind: 'chosen';
      readonly playbook: Playbook;
      readonly input: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: 'refused'; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Which playbook a task gets, or why none. Every refusal is a sentence a
 * person can act on, and none of them has opened a browser.
 */
export function choosePlaybook(registry: PlaybookRegistry, task: Task): PlaybookChoice {
  if (task.mode !== 'playbook') {
    return { kind: 'refused', reason: `${task.mode} mode has no runner yet` };
  }
  if (!isRecord(task.input)) return { kind: 'refused', reason: 'the task input is not an object' };
  const site = task.input['site'];
  if (typeof site !== 'string' || site.trim() === '') {
    return { kind: 'refused', reason: 'the task input names no site' };
  }
  const playbook = registry.lookup(site, task.kind);
  if (playbook === undefined) {
    return { kind: 'refused', reason: `no playbook for ${task.kind} on ${site}` };
  }
  return { kind: 'chosen', playbook, input: task.input };
}

/** The latest accepted reply to exactly this question. */
export function answerTo(answers: readonly TaskAnswer[], question: string): string | undefined {
  for (let index = answers.length - 1; index >= 0; index -= 1) {
    const answer = answers[index];
    if (answer !== undefined && answer.question === question) return answer.reply;
  }
  return undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function settle(step: PlaybookStep, page: Page, context: PlaybookContext): Promise<StepOutcome> {
  try {
    return await step.run(page, context);
  } catch (error: unknown) {
    return { kind: 'failed', reason: describe(error) };
  }
}

function trailDetail(outcome: StepOutcome): unknown {
  switch (outcome.kind) {
    case 'done':
      return outcome.detail;
    case 'ask':
      return { question: outcome.question };
    case 'failed':
      return outcome.detail === undefined
        ? { reason: outcome.reason }
        : { reason: outcome.reason, detail: outcome.detail };
  }
}

/**
 * The steps, in order, on one page. Each step's outcome goes on the trail
 * before the next step starts, so a trail read mid-run says where the run
 * is. A guard stop wins over whatever the step was doing and over the trail:
 * once the guard has stopped, nothing more is written here, because the
 * session is being released under the step and the stop is the mission's
 * outcome, not the step's.
 */
export async function runSteps(
  playbook: Playbook,
  page: Page,
  context: PlaybookContext,
  guard: Pick<Guardrails, 'stop'>,
  log: (payload: StepEventPayload) => Promise<void>,
): Promise<MissionOutcome> {
  const completed: { readonly name: string; readonly detail?: unknown }[] = [];
  for (const step of playbook.steps) {
    if (guard.stop !== undefined) return stopOutcome(guard.stop);
    const outcome = await settle(step, page, context);
    if (guard.stop !== undefined) return stopOutcome(guard.stop);
    const detail = trailDetail(outcome);
    await log(
      detail === undefined
        ? { name: step.name, outcome: outcome.kind }
        : { name: step.name, outcome: outcome.kind, detail },
    );
    switch (outcome.kind) {
      case 'done':
        completed.push(
          outcome.detail === undefined
            ? { name: step.name }
            : { name: step.name, detail: outcome.detail },
        );
        break;
      case 'ask':
        return { kind: 'ask', question: outcome.question };
      case 'failed':
        return outcome.detail === undefined
          ? { kind: 'failed', reason: `${step.name}: ${outcome.reason}` }
          : { kind: 'failed', reason: `${step.name}: ${outcome.reason}`, detail: outcome.detail };
    }
  }
  return { kind: 'succeeded', result: { playbook: playbook.id, steps: completed } };
}

function refusal(reason: string): MissionOutcome {
  return { kind: 'failed', reason };
}

/** The mission a worker registers the task engine with. */
export function createPlaybookMission(options: PlaybookRunnerOptions): Mission {
  const credentials = options.credentials ?? profileCredentials;
  return async ({ task, answers, step }) => {
    const choice = choosePlaybook(options.registry, task);
    if (choice.kind === 'refused') return refusal(choice.reason);
    const { playbook } = choice;
    await recordPlaybook(options.db, task.id, playbook.id);
    const connection = await readSiteConnection(options.db, task.userId, playbook.siteDomain);
    if (connection === undefined) return refusal(`no site connection for ${playbook.siteDomain}`);
    if (connection.status !== 'connected') {
      return refusal(`the site connection for ${playbook.siteDomain} is ${connection.status}`);
    }
    const credential = await credentials(connection, task);
    if (credential === undefined) return refusal(`no credential for ${playbook.siteDomain}`);
    const context: PlaybookContext = {
      task,
      input: choice.input,
      connection,
      credential,
      answers,
      answerTo: (question) => answerTo(answers, question),
    };
    const request: BrowserRequest =
      credential.kind === 'profile'
        ? { ...options.request, profileId: credential.profileId }
        : { ...options.request };
    const run = await guardedSession(
      {
        provider: options.provider,
        policy: { allowlist: playbook.allowlist, confirmedPayments: paymentConfirmations(answers) },
        request,
      },
      async (page, session, guard) => {
        await recordBrowserSession(options.db, task.id, session);
        return runSteps(playbook, page, context, guard, step);
      },
    );
    return run.outcome.kind === 'stopped' ? stopOutcome(run.outcome.stop) : run.outcome.value;
  };
}
