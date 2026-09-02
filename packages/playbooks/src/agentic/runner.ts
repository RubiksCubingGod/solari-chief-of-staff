import type Anthropic from '@anthropic-ai/sdk';
import {
  OPUS_5_PRICING,
  chargeLlmCall,
  costOfLlmUsage,
  emptyTaskLlmUsage,
  type LlmPricing,
  type StepEventPayload,
  type TaskLlmUsage,
} from '@chief-of-staff/core';
import {
  readSiteConnection,
  readTaskTimeline,
  recordBrowserSession,
  tasks,
  type Mission,
  type MissionOutcome,
  type TaskDatabase,
} from '@chief-of-staff/db';
import { withBrowser, type BrowserProvider, type BrowserRequest } from '@chief-of-staff/solari';
import { eq } from 'drizzle-orm';

import {
  guardedRequest,
  installGuardrails,
  paymentConfirmations,
  stopOutcome,
  type SessionEcho,
} from '../guardrails/index.js';
import { profileCredentials, type CredentialSource } from '../runner/runner.js';
import {
  DEFAULT_AGENTIC_BUDGETS,
  backoffWithin,
  chargeTokens,
  checkBudgets,
  describeExhaustion,
  type AgenticBudgets,
  type BudgetExhaustion,
  type BudgetLedger,
} from './budget.js';
import type { DigestLimits } from './digest.js';
import {
  DEFAULT_MODEL_RETRY,
  callModel,
  retryDelayMs,
  type ModelAnswer,
  type ModelMessage,
  type ModelRetryPolicy,
  type ModelToolResult,
} from './model.js';
import { AGENTIC_SYSTEM_PROMPT, NUDGE, missionBrief } from './prompt.js';
import { BROWSER_TOOLS, createBrowserToolset, type ToolExecution } from './tools.js';

/**
 * The fallback brain: the mission a task gets when no playbook claims it.
 * A Claude tool loop over the browser toolset, inside the same frame every
 * playbook runs in - the s5 engine drives the transitions, the guardrails
 * sit beneath the tools, the session is recorded - with three hard budgets
 * enforced here rather than asked of the model, and every call's tokens
 * and cost written to the task's row as they are spent.
 */

export const AGENTIC_MODEL = 'claude-opus-5';
export const AGENTIC_MAX_OUTPUT_TOKENS = 2_048;

export interface AgenticMissionOptions {
  readonly db: TaskDatabase;
  readonly provider: BrowserProvider;
  readonly client: Anthropic;
  readonly model?: string;
  readonly pricing?: LlmPricing;
  readonly budgets?: Partial<AgenticBudgets>;
  readonly retry?: ModelRetryPolicy;
  /** What a connection yields for signing in. The connection's profile unless told otherwise. */
  readonly credentials?: CredentialSource;
  /** Asked of every session, under the runner's own asks: the recording, and the profile. */
  readonly request?: BrowserRequest;
  readonly limits?: Partial<DigestLimits>;
  readonly actionTimeoutMs?: number;
  readonly navigationTimeoutMs?: number;
  readonly maxOutputTokens?: number;
  /** The mission's clock, for the wall-time budget. */
  readonly now?: () => number;
  /** How a backoff waits. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export type AgenticStart =
  | { readonly ok: true; readonly url: URL; readonly input: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly reason: string };

const START_REASON = 'agentic mode needs input.url: an absolute http(s) URL to start at';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Where the mission starts, or why it cannot. An agentic task is defined by its start URL. */
export function agenticStart(input: unknown): AgenticStart {
  const record = isRecord(input) ? input : {};
  const raw = record['url'];
  if (typeof raw === 'string' && URL.canParse(raw)) {
    const url = new URL(raw);
    if (url.protocol === 'http:' || url.protocol === 'https:') return { ok: true, url, input: record };
  }
  return { ok: false, reason: START_REASON };
}

/** The value with every secret struck out of every string in it, however deep. */
export function redactSecrets(value: unknown, secrets: readonly string[]): unknown {
  const live = secrets.filter((secret) => secret !== '');
  if (live.length === 0) return value;
  const scrub = (item: unknown): unknown => {
    if (typeof item === 'string') {
      return live.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), item);
    }
    if (Array.isArray(item)) return item.map(scrub);
    if (isRecord(item)) return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, scrub(entry)]));
    return item;
  };
  return scrub(value);
}

function refusal(reason: string): MissionOutcome {
  return { kind: 'failed', reason };
}

function declared(execution: Extract<ToolExecution, { kind: 'outcome' }>): MissionOutcome {
  switch (execution.status) {
    case 'succeeded':
      return { kind: 'succeeded', result: { mode: 'agentic', status: 'succeeded', detail: execution.detail } };
    case 'failed':
      return { kind: 'failed', reason: execution.detail, detail: { mode: 'agentic', status: 'failed' } };
    case 'blocked':
      return {
        kind: 'failed',
        reason: `blocked: ${execution.detail}`,
        detail: { mode: 'agentic', status: 'blocked' },
      };
  }
}

/** The mission a worker hands `createPlaybookMission` as its fallback. */
export function createAgenticMission(options: AgenticMissionOptions): Mission {
  const model = options.model ?? AGENTIC_MODEL;
  const pricing = options.pricing ?? OPUS_5_PRICING;
  const budgets: AgenticBudgets = { ...DEFAULT_AGENTIC_BUDGETS, ...options.budgets };
  const retry = options.retry ?? DEFAULT_MODEL_RETRY;
  const credentials = options.credentials ?? profileCredentials;
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const maxOutputTokens = options.maxOutputTokens ?? AGENTIC_MAX_OUTPUT_TOKENS;

  return async ({ task, answers, step }) => {
    const start = agenticStart(task.input);
    if (!start.ok) return refusal(start.reason);
    const host = start.url.host;
    const connection = await readSiteConnection(options.db, task.userId, host);
    if (connection !== undefined && connection.status !== 'connected') {
      return refusal(`the site connection for ${host} is ${connection.status}`);
    }
    const credential = connection === undefined ? undefined : await credentials(connection, task);
    const secrets = credential?.kind === 'password' ? [credential.password] : [];
    const log = async (payload: StepEventPayload): Promise<void> => {
      await step(redactSecrets(payload, secrets) as StepEventPayload);
    };
    const timeline = await readTaskTimeline(options.db, task.id);
    const brief = missionBrief({
      kind: task.kind,
      input: start.input,
      url: start.url.href,
      host,
      credential,
      answers,
      history: timeline?.events ?? [],
      budgets,
    });
    const request: BrowserRequest =
      credential?.kind === 'profile'
        ? { ...options.request, profileId: credential.profileId }
        : { ...options.request };

    const startedAt = now();
    const elapsed = (): number => now() - startedAt;
    let total: TaskLlmUsage = task.llmUsage ?? emptyTaskLlmUsage(model);
    const charge = async (answer: ModelAnswer): Promise<void> => {
      total = chargeLlmCall(total, answer.usage, pricing);
      await options.db.update(tasks).set({ llmUsage: total }).where(eq(tasks.id, task.id));
      await log({
        name: 'llm',
        outcome: 'ok',
        detail: {
          model,
          stopReason: answer.stopReason,
          ...answer.usage,
          costUsd: costOfLlmUsage(answer.usage, pricing),
        },
      });
    };
    const exhausted = async (exhaustion: BudgetExhaustion): Promise<MissionOutcome> => {
      await log({ name: 'budget', outcome: 'exhausted', detail: exhaustion });
      return {
        kind: 'failed',
        reason: describeExhaustion(exhaustion),
        detail: { mode: 'agentic', status: 'budget', ...exhaustion },
      };
    };
    const wallOut = (): BudgetExhaustion => ({ axis: 'wall_time', used: elapsed(), limit: budgets.maxWallMs });

    type Turn =
      | { readonly kind: 'answered'; readonly answer: ModelAnswer }
      | { readonly kind: 'ended'; readonly outcome: MissionOutcome };

    /** One model turn, retried through outages as long as the wall clock allows. */
    const askModel = async (messages: readonly ModelMessage[]): Promise<Turn> => {
      for (let attempt = 1; ; attempt += 1) {
        const remaining = budgets.maxWallMs - elapsed();
        if (remaining <= 0) return { kind: 'ended', outcome: await exhausted(wallOut()) };
        const result = await callModel(options.client, {
          model,
          maxTokens: maxOutputTokens,
          system: AGENTIC_SYSTEM_PROMPT,
          tools: BROWSER_TOOLS,
          messages,
          timeoutMs: Math.max(1_000, remaining),
        });
        if (result.kind === 'answered') return { kind: 'answered', answer: result };
        const status = result.status === undefined ? {} : { status: result.status };
        if (!result.retryable || attempt >= retry.attempts) {
          await log({ name: 'llm', outcome: 'error', detail: { attempts: attempt, ...status, message: result.message } });
          const httpStatus = result.status === undefined ? {} : { httpStatus: result.status };
          return {
            kind: 'ended',
            outcome: {
              kind: 'failed',
              cause: 'error',
              reason: result.retryable
                ? `the model was unavailable after ${String(attempt)} attempts: ${result.message}`
                : `the model rejected the request: ${result.message}`,
              detail: { mode: 'agentic', status: 'error', attempts: attempt, ...httpStatus },
            },
          };
        }
        const delayMs = backoffWithin(budgets, elapsed(), retryDelayMs(retry, attempt));
        if (delayMs === undefined) return { kind: 'ended', outcome: await exhausted(wallOut()) };
        await log({ name: 'llm', outcome: 'retry', detail: { attempt, ...status, message: result.message, delayMs } });
        await sleep(delayMs);
      }
    };

    return withBrowser(options.provider, guardedRequest(request), async (session) => {
      const echo: SessionEcho = {
        provider: options.provider.name,
        sessionId: session.meta.sessionId,
        recording: session.meta.recording,
      };
      await recordBrowserSession(options.db, task.id, echo);
      const guard = await installGuardrails(session.context, {
        allowlist: [start.url.hostname],
        confirmedPayments: paymentConfirmations(answers),
      });
      const page = await session.newPage();
      const toolset = createBrowserToolset({
        page,
        guard,
        log,
        ...(options.limits === undefined ? {} : { limits: options.limits }),
        ...(options.actionTimeoutMs === undefined ? {} : { actionTimeoutMs: options.actionTimeoutMs }),
        ...(options.navigationTimeoutMs === undefined ? {} : { navigationTimeoutMs: options.navigationTimeoutMs }),
      });

      const messages: ModelMessage[] = [{ role: 'user', content: brief }];
      let ledger: BudgetLedger = { toolCalls: 0, tokens: 0, elapsedMs: 0 };
      let violations = 0;
      for (;;) {
        ledger = { ...ledger, elapsedMs: elapsed() };
        const beforeTurn = checkBudgets(budgets, ledger, 'turn');
        if (beforeTurn !== undefined) return exhausted(beforeTurn);
        const turn = await askModel(messages);
        if (turn.kind === 'ended') return turn.outcome;
        const { answer } = turn;
        await charge(answer);
        ledger = { ...chargeTokens(ledger, answer.usage), toolCalls: ledger.toolCalls + 1, elapsedMs: elapsed() };
        messages.push({ role: 'assistant', content: [...answer.content] });
        const afterTokens = checkBudgets(budgets, ledger, 'tokens');
        if (afterTokens !== undefined) return exhausted(afterTokens);
        if (answer.stopReason === 'refusal') {
          return { kind: 'failed', reason: 'the model refused to continue', detail: { mode: 'agentic', status: 'failed' } };
        }
        if (answer.toolUses.length === 0) {
          messages.push({ role: 'user', content: NUDGE });
          continue;
        }
        const results: ModelToolResult[] = [];
        for (const use of answer.toolUses) {
          ledger = { ...ledger, elapsedMs: elapsed() };
          const beforeTool = checkBudgets(budgets, ledger, 'tool');
          if (beforeTool !== undefined) return exhausted(beforeTool);
          const execution = await toolset.execute(use.name, use.input);
          results.push(
            execution.kind === 'error'
              ? { type: 'tool_result', tool_use_id: use.id, content: execution.text, is_error: true }
              : { type: 'tool_result', tool_use_id: use.id, content: execution.text },
          );
          if (execution.kind === 'ask') return { kind: 'ask', question: execution.question };
          if (execution.kind === 'outcome') return declared(execution);
          if (execution.kind === 'error' && execution.failure.kind === 'guardrail') {
            const { stop } = execution.failure;
            // A payment gate is a question for the person, not a mistake to
            // tell the model about: parking now keeps the fingerprint the
            // confirmation is matched by.
            if (stop.kind === 'payment') return stopOutcome(stop);
            violations += 1;
            if (violations >= 2) return stopOutcome(stop);
          }
        }
        messages.push({ role: 'user', content: results });
      }
    });
  };
}
