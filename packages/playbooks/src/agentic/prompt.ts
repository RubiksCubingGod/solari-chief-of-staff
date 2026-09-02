import type { StepEventPayload, TaskKind } from '@chief-of-staff/core';

import type { SiteCredential } from '../runner/playbook.js';
import type { AgenticBudgets } from './budget.js';

/**
 * The words the runner gives the model: the standing instructions, which
 * never change and so are cached; the brief, which is everything this task
 * and this run know; and the nudge, for a turn that called nothing.
 *
 * None of it is where a rule is enforced. The allowlist, the payment gate,
 * the budgets and the outcome mapping all live in code; the prompt tells the
 * model about them so it spends its turns well, not so it obeys.
 */

export const AGENTIC_SYSTEM_PROMPT = [
  'You are the action agent of Chief of Staff, a personal assistant service. You carry out one task in a real web browser on behalf of the person the task belongs to, using only the tools you are given, and you report what actually happened.',
  '',
  'Your tools: navigate to a URL on the allowed host; read the page for a fresh digest of it; click an element, type into a field, or select an option, each by the ref the digest gave it; ask_user for something only the person knows; declare_outcome when the mission is over.',
  '',
  'How to work:',
  '- Start with navigate to the URL in the brief, then read the page. Every ref (like e12) comes from the latest digest of the page; after any action that changes the page, read it again before using refs from it.',
  "- Take one step at a time. Prefer the site's own links, buttons and forms over guessing URLs.",
  '- The guardrails admit only the host named in the brief. A navigation anywhere else is refused and ends the browser session; after that, only ask_user and declare_outcome still work.',
  '- Never enter card details and never submit a payment. If the task cannot be done without one, call ask_user and stop.',
  '- When you need something only the person has - a code that was sent to them, a choice that is theirs to make - call ask_user with one clear question. The task pauses, and you will be started again with their answer in the brief.',
  '- When a page blocks you - a CAPTCHA, an access-denied or bot-check page, a sign-in you cannot complete - do not try to get around it. Call declare_outcome with status blocked and say what you saw.',
  '- Finish with declare_outcome. Use succeeded only for an outcome the page itself has confirmed, and quote that confirmation in the detail. Use failed when the task cannot be done, and say why. Never report a success you have not seen.',
  '- Your turns and tokens are limited. Do not re-read a page you have already read unless something changed it.',
  '- Answer with tool calls only. Explanations belong in the detail of declare_outcome.',
].join('\n');

/** What the loop says back to a turn that used no tool. */
export const NUDGE =
  'You called no tool. Answer with tool calls only: continue the mission with a tool, or call declare_outcome with what you found.';

/** An answer the person gave, in the two fields the brief repeats. */
export interface BriefAnswer {
  readonly question: string;
  readonly reply: string;
}

/** A trail event, in the two fields the summary reads. */
export interface BriefEvent {
  readonly type: string;
  readonly payload: unknown;
}

export interface MissionBriefInput {
  readonly kind: TaskKind;
  readonly input: Readonly<Record<string, unknown>>;
  readonly url: string;
  readonly host: string;
  readonly credential: SiteCredential | undefined;
  readonly answers: readonly BriefAnswer[];
  /** The task's trail before this run, oldest first. */
  readonly history: readonly BriefEvent[];
  readonly budgets: AgenticBudgets;
}

const GOALS: Record<TaskKind, string> = {
  cancel:
    "Cancel the person's membership or subscription on this site and get the site's own confirmation that it is cancelled.",
  book_slot: "Book the appointment or slot the task input describes and get the site's confirmation of the booking.",
  custom: 'Do what the task input describes.',
};

/** The goal in the input when it says one, otherwise what the kind of task means. */
export function goalFor(kind: TaskKind, input: Readonly<Record<string, unknown>>): string {
  const goal = input['goal'];
  if (typeof goal === 'string' && goal.trim() !== '') return goal.trim();
  return GOALS[kind];
}

export function describeCredential(credential: SiteCredential | undefined): string {
  if (credential === undefined) {
    return 'Credentials: none. If the site needs a sign-in you cannot complete, ask the person or declare the outcome.';
  }
  if (credential.kind === 'profile') {
    return "Credentials: the browser carries the person's saved profile for this site, so expect to be signed in already. If you are not, ask the person rather than guessing.";
  }
  return `Credentials: sign in with email ${credential.username} and password ${credential.password}. Enter them only into the site's own sign-in form.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function quote(text: string): string {
  return `"${text}"`;
}

function argsOf(tool: string, input: Record<string, unknown>): string {
  const text = (key: string): string => (typeof input[key] === 'string' ? input[key] : '');
  switch (tool) {
    case 'navigate':
      return text('url');
    case 'click':
      return text('ref');
    case 'type':
      return `${text('ref')} ${quote(text('text'))}`;
    case 'select':
      return `${text('ref')} ${quote(text('option'))}`;
    case 'declare_outcome':
      return text('status');
    default:
      return '';
  }
}

function whatHappened(detail: Record<string, unknown>): string {
  const result = detail['result'];
  if (isRecord(result)) {
    if (result['kind'] === 'digest') return `Page ${quote(String(result['title']))} at ${String(result['url'])}`;
    if (result['kind'] === 'field') return `now ${quote(String(result['value']))}`;
  }
  const failure = detail['failure'];
  if (isRecord(failure)) {
    const kind = String(failure['kind']);
    if (typeof failure['reason'] === 'string') return `${kind}: ${failure['reason']}`;
    if (Array.isArray(failure['issues'])) return `${kind}: ${failure['issues'].map(String).join('; ')}`;
    return kind;
  }
  if (typeof detail['question'] === 'string') return `asked ${quote(detail['question'])}`;
  if (typeof detail['status'] === 'string') return `declared ${detail['status']}: ${String(detail['detail'])}`;
  return '';
}

/**
 * The tool uses on a trail, one line each, most recent last. Only tool steps:
 * the model needs to know what was tried and what came of it, not what the
 * runner paid or which session it was.
 */
export function summarizeHistory(events: readonly BriefEvent[], limit = 40): string[] {
  const lines: string[] = [];
  for (const event of events) {
    if (event.type !== 'step' || !isRecord(event.payload)) continue;
    const payload = event.payload as unknown as StepEventPayload;
    if (typeof payload.name !== 'string' || !payload.name.startsWith('tool:')) continue;
    const tool = payload.name.slice('tool:'.length);
    const detail = isRecord(payload.detail) ? payload.detail : {};
    const input = isRecord(detail['input']) ? detail['input'] : {};
    const args = argsOf(tool, input);
    const what = whatHappened(detail);
    lines.push(
      `${tool}${args === '' ? '' : ` ${args}`} -> ${payload.outcome ?? 'unknown'}${what === '' ? '' : `: ${what}`}`,
    );
  }
  const omitted = Math.max(0, lines.length - limit);
  const kept = lines.slice(omitted).map((line, index) => `${String(omitted + index + 1)}. ${line}`);
  return omitted === 0 ? kept : [`(${String(omitted)} earlier tool uses omitted)`, ...kept];
}

export function missionBrief(input: MissionBriefInput): string {
  const { budgets } = input;
  const lines = [
    `Mission: ${input.kind}`,
    `Goal: ${goalFor(input.kind, input.input)}`,
    `Start at: ${input.url}`,
    `Allowed host: ${input.host}. The guardrails refuse navigation to any other host.`,
    describeCredential(input.credential),
    `Task input: ${JSON.stringify(input.input)}`,
    `Budget: at most ${String(budgets.maxToolCalls)} turns and ${String(budgets.maxTokens)} tokens, within ${String(Math.round(budgets.maxWallMs / 1_000))} seconds of wall time.`,
  ];
  if (input.answers.length > 0) {
    lines.push('', 'The person answered:');
    for (const answer of input.answers) lines.push(`- Q: ${answer.question}`, `  A: ${answer.reply}`);
  }
  const history = summarizeHistory(input.history);
  if (history.length > 0) {
    lines.push('', 'Earlier in this task, the tools were used like this:', ...history);
    lines.push('Pick up from there. Do not ask a question the person has already answered.');
  }
  return lines.join('\n');
}
