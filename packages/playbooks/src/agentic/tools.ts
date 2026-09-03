import type { StepEventPayload } from '@chief-of-staff/core';
import type { Frame, Locator, Page } from 'playwright';
import { z } from 'zod';

import { stopOutcome, type GuardStop, type Guardrails } from '../guardrails/guardrails.js';
import {
  DEFAULT_DIGEST_LIMITS,
  DigestError,
  REF_ATTRIBUTE,
  REF_PATTERN,
  digestPage,
  isLocated,
  maxCharsFor,
  renderDigest,
  resolveScript,
  type DigestLimits,
  type Located,
  type PageDigest,
} from './digest.js';

/**
 * The tool surface: the only hands the model has (browser-toolset spec).
 * Seven tools, each with a schema that says what a well-formed call is and an
 * executor that runs it against the guarded page. Every call - including one
 * that names no tool, or fits no schema - comes back as a typed execution and
 * lands on the task's trail, so the tool-call log is the mission's audit.
 *
 * The guard stays beneath everything here. A tool never checks the allowlist
 * itself: the navigation goes out, the guard refuses it, the session ends,
 * and the refusal comes back to the model as a `guardrail` failure that says
 * why. From then on every browser tool answers with the same failure; only
 * `ask_user` and `declare_outcome`, which need no page, still work.
 */

export const TOOL_NAMES = [
  'navigate',
  'click',
  'type',
  'select',
  'read',
  'ask_user',
  'declare_outcome',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export function isToolName(value: string): value is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(value);
}

/** What a model can declare: done with evidence, failed with a reason, or refused by the site. */
export const OUTCOME_STATUSES = ['succeeded', 'failed', 'blocked'] as const;
export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

const ref = z
  .string()
  .regex(REF_PATTERN, { error: 'must be a ref from the latest digest, like "e12"' });

export const TOOL_INPUT_SCHEMAS = {
  navigate: z.object({
    url: z.url({ protocol: /^https?$/, error: 'must be an absolute http(s) URL, scheme included' }),
  }),
  click: z.object({ ref }),
  type: z.object({ ref, text: z.string() }),
  select: z.object({ ref, option: z.string().min(1) }),
  read: z.object({}),
  ask_user: z.object({ question: z.string().trim().min(1) }),
  declare_outcome: z.object({
    status: z.enum(OUTCOME_STATUSES),
    detail: z.string().trim().min(1),
  }),
} as const satisfies Record<ToolName, z.ZodType>;

export type ToolArgs<T extends ToolName> = z.output<(typeof TOOL_INPUT_SCHEMAS)[T]>;

const DESCRIPTIONS: Record<ToolName, string> = {
  navigate:
    'Open an absolute http(s) URL in the current tab and return the digest of the page that loaded. Only hosts on the task allowlist can be opened; trying any other host is a violation that ends the task.',
  click:
    'Click the element with the given ref from the latest digest: a link, a button, a checkbox or a radio. Waits for any page load the click starts and returns the fresh digest.',
  type: 'Replace the contents of a text field or textarea, named by ref, with the given text. Does not submit anything: click the form button afterwards.',
  select:
    'Choose an option in a select element named by ref. Give the option by its visible label or by its value, exactly as the digest lists them.',
  read: 'Return a fresh digest of the current page: URL, title, the interactive elements with their refs, and the visible text. Call it whenever a ref has gone stale or the page may have changed.',
  ask_user:
    'Ask the person one question you cannot answer from the page: a code from their inbox, a choice only they can make. The task pauses until they answer; the answer arrives with the next run, in your instructions.',
  declare_outcome:
    'End the task honestly. succeeded: say what on the page proves it. failed: say why it cannot be done. blocked: the site refused access (captcha, verification wall, ban) and detail says what you saw.',
};

export interface ToolDefinition {
  readonly name: ToolName;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  /** The same schema as JSON Schema, for a transport that takes tools that way. */
  readonly jsonSchema: Record<string, unknown>;
}

function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(z.toJSONSchema(schema)).filter(([key]) => key !== '$schema'),
  );
}

/** The seven tools, in the order the model is told about them. */
export const BROWSER_TOOLS: readonly ToolDefinition[] = TOOL_NAMES.map((name) => ({
  name,
  description: DESCRIPTIONS[name],
  inputSchema: TOOL_INPUT_SCHEMAS[name],
  jsonSchema: jsonSchemaOf(TOOL_INPUT_SCHEMAS[name]),
}));

/* What a call comes back as. */

export type ToolFailure =
  | { readonly kind: 'unknown-tool'; readonly tool: string }
  | { readonly kind: 'invalid-arguments'; readonly tool: ToolName; readonly issues: readonly string[] }
  | {
      readonly kind: 'stale-ref';
      readonly ref: string;
      /** `unknown`: never handed out. `missing`: no longer on the page. `changed`: still there, but not what it was. */
      readonly reason: 'unknown' | 'missing' | 'changed';
    }
  | { readonly kind: 'not-interactable'; readonly ref: string; readonly reason: string }
  | {
      readonly kind: 'no-such-option';
      readonly ref: string;
      readonly option: string;
      readonly options: readonly string[];
    }
  | { readonly kind: 'navigation-failed'; readonly url: string; readonly reason: string }
  | { readonly kind: 'timeout'; readonly tool: ToolName; readonly reason: string }
  | { readonly kind: 'guardrail'; readonly reason: string; readonly stop: GuardStop }
  | { readonly kind: 'page-error'; readonly tool: ToolName; readonly reason: string };

export interface PageLocation {
  readonly url: string;
  readonly title: string;
}

export type ToolResult =
  | { readonly kind: 'digest'; readonly digest: PageDigest }
  | {
      readonly kind: 'field';
      readonly page: PageLocation;
      readonly ref: string;
      /** What the field holds now: the text typed, or the label of the option chosen. */
      readonly value: string;
    };

/**
 * One call, settled. `text` is what the model reads; the rest is what the
 * runner and the trail keep. `ask` and `outcome` are the two endings: the
 * toolset reports them, the runner acts on them.
 */
export type ToolExecution =
  | { readonly kind: 'ok'; readonly tool: ToolName; readonly result: ToolResult; readonly text: string }
  | { readonly kind: 'error'; readonly tool: string; readonly failure: ToolFailure; readonly text: string }
  | { readonly kind: 'ask'; readonly question: string; readonly text: string }
  | {
      readonly kind: 'outcome';
      readonly status: OutcomeStatus;
      readonly detail: string;
      readonly text: string;
    };

function quote(text: string): string {
  return `"${text}"`;
}

/** The failure in words the model can act on. */
export function describeToolFailure(failure: ToolFailure): string {
  switch (failure.kind) {
    case 'unknown-tool':
      return `There is no tool named ${quote(failure.tool)}. The tools are: ${TOOL_NAMES.join(', ')}.`;
    case 'invalid-arguments':
      return `The arguments to ${failure.tool} do not fit its schema: ${failure.issues.join('; ')}. Fix them and call again.`;
    case 'stale-ref':
      switch (failure.reason) {
        case 'unknown':
          return `Ref ${failure.ref} is not from any digest of this page. Call read and use a ref from the fresh digest.`;
        case 'missing':
          return `Ref ${failure.ref} is no longer on the page: it navigated or changed since that digest. Call read and use a ref from the fresh digest.`;
        case 'changed':
          return `The element at ${failure.ref} is not what it was when the digest was taken. Call read and use a ref from the fresh digest.`;
      }
      break;
    case 'not-interactable':
      return `Cannot act on ${failure.ref}: ${failure.reason}.`;
    case 'no-such-option':
      return `${failure.ref} has no option ${quote(failure.option)}. Its options are: ${failure.options.map(quote).join(', ')}.`;
    case 'navigation-failed':
      return `Could not open ${failure.url}: ${failure.reason}.`;
    case 'timeout':
      return failure.tool === 'navigate'
        ? `navigate timed out: ${failure.reason}. The page did not finish loading in time; try again, or declare the outcome if it keeps stalling.`
        : `${failure.tool} timed out: ${failure.reason}. The page may be busy or the element covered; read it again before retrying.`;
    case 'guardrail':
      return `The guardrails stopped the browser: ${failure.reason}. The browser session has ended and no further page action is possible; declare the outcome honestly.`;
    case 'page-error':
      return `${failure.tool} failed: ${failure.reason}.`;
  }
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String).join('.');
  return path === '' ? issue.message : `${path}: ${issue.message}`;
}

export type ParsedToolInput<T extends ToolName> =
  | { readonly ok: true; readonly args: ToolArgs<T> }
  | { readonly ok: false; readonly failure: ToolFailure };

/** Validates a call's arguments against the tool's schema, naming every field that does not fit. */
export function parseToolInput<T extends ToolName>(tool: T, input: unknown): ParsedToolInput<T> {
  const parsed = TOOL_INPUT_SCHEMAS[tool].safeParse(input);
  if (parsed.success) return { ok: true, args: parsed.data as ToolArgs<T> };
  return {
    ok: false,
    failure: { kind: 'invalid-arguments', tool, issues: parsed.error.issues.map(describeIssue) },
  };
}

/** The trail's `outcome` for an execution: `ok`, the failure kind, or the ending. */
function outcomeOf(execution: ToolExecution): string {
  switch (execution.kind) {
    case 'ok':
      return 'ok';
    case 'error':
      return execution.failure.kind;
    case 'ask':
      return 'ask';
    case 'outcome':
      return 'declared';
  }
}

/**
 * What the trail keeps of an execution. A digest is summarised to its counts:
 * the recording holds the page, the trail holds what the model was told about
 * it and what it did.
 */
export function trailDetail(execution: ToolExecution): Record<string, unknown> {
  switch (execution.kind) {
    case 'ok':
      return {
        result:
          execution.result.kind === 'digest'
            ? {
                kind: 'digest',
                url: execution.result.digest.url,
                title: execution.result.digest.title,
                elements: execution.result.digest.elements.length,
                regions: execution.result.digest.regions.length,
                truncation: execution.result.digest.truncation,
              }
            : execution.result,
      };
    case 'error':
      return { failure: execution.failure };
    case 'ask':
      return { question: execution.question };
    case 'outcome':
      return { status: execution.status, detail: execution.detail };
  }
}

/* The toolset. */

export interface BrowserToolsetOptions {
  readonly page: Page;
  /** The guard over the page's context; its `stop` is read before and after every browser tool. */
  readonly guard: Pick<Guardrails, 'stop'>;
  /** Appends one step to the task's trail; the mission's `step`. */
  readonly log: (payload: StepEventPayload) => Promise<void>;
  readonly limits?: Partial<DigestLimits>;
  /** How long a click, fill or select may wait for its element. */
  readonly actionTimeoutMs?: number;
  /** How long a navigation, or the load a click starts, may take. */
  readonly navigationTimeoutMs?: number;
}

export interface BrowserToolset {
  readonly tools: readonly ToolDefinition[];
  /** Runs one call as the model made it: any name, any arguments. Never throws for a bad call. */
  execute(tool: string, input: unknown): Promise<ToolExecution>;
  /** The last digest handed to the model, if any. */
  readonly latest: PageDigest | undefined;
}

/**
 * Whether a navigation was cut short by Chromium's own error page landing
 * late. A navigation that fails on the wire commits `chrome-error://` a
 * moment afterwards; under load that moment can come after the model's next
 * navigate has started, which then fails for a reason that is not its own.
 * The sentence is Playwright's.
 */
export function interruptedByErrorPage(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('interrupted by another navigation to "chrome-error://')
  );
}

/** Whether a navigation was cut short by any other navigation committing in its frame. */
function interruptedByNavigation(error: unknown): boolean {
  return error instanceof Error && error.message.includes('is interrupted by another navigation to "');
}

export const DEFAULT_ACTION_TIMEOUT_MS = 10_000;
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 20_000;
/** How long after a click to watch for a navigation it may have started. */
const SETTLE_MS = 250;

type Lookup =
  | { readonly ok: true; readonly element: Extract<Located, { readonly found: true }> }
  | { readonly ok: false; readonly failure: ToolFailure };

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const line = message.split('\n')[0] ?? message;
  return line
    .replace(/^(?:page|locator|frame)\.\w+: /, '')
    .trim()
    .replace(/\.+$/, '');
}

export function createBrowserToolset(options: BrowserToolsetOptions): BrowserToolset {
  const { page, guard, log } = options;
  const limits: DigestLimits = { ...DEFAULT_DIGEST_LIMITS, ...options.limits };
  const actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const navigationTimeoutMs = options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
  const signatures = new Map<string, string>();
  let nextRef = 1;
  let latest: PageDigest | undefined;

  const failed = (tool: string, failure: ToolFailure): ToolExecution => ({
    kind: 'error',
    tool,
    failure,
    text: describeToolFailure(failure),
  });

  function guardrail(stop: GuardStop): ToolFailure {
    const outcome = stopOutcome(stop);
    const reason =
      outcome.kind === 'failed'
        ? outcome.reason
        : outcome.kind === 'ask'
          ? outcome.question
          : 'the guardrails stopped the session';
    return { kind: 'guardrail', reason, stop };
  }

  function classify(error: unknown, tool: ToolName, url: string | undefined): ToolFailure {
    if (guard.stop !== undefined) return guardrail(guard.stop);
    const reason = firstLine(error);
    if (error instanceof Error && error.name === 'TimeoutError') return { kind: 'timeout', tool, reason };
    if (tool === 'navigate' && url !== undefined) return { kind: 'navigation-failed', url, reason };
    return { kind: 'page-error', tool, reason };
  }

  /** Runs a tool that needs the page, with the guard's stop read before and after. */
  async function onPage(
    tool: ToolName,
    body: () => Promise<ToolExecution>,
    url?: string,
  ): Promise<ToolExecution> {
    if (guard.stop !== undefined) return failed(tool, guardrail(guard.stop));
    if (page.isClosed()) return failed(tool, { kind: 'page-error', tool, reason: 'the page is closed' });
    try {
      const execution = await body();
      return guard.stop === undefined ? execution : failed(tool, guardrail(guard.stop));
    } catch (error) {
      return failed(tool, classify(error, tool, url));
    }
  }

  async function read(tool: ToolName): Promise<ToolExecution> {
    const reading = await digestPage(page, { limits, nextRef });
    nextRef = reading.nextRef;
    for (const [handle, signature] of reading.signatures) signatures.set(handle, signature);
    latest = reading.digest;
    return {
      kind: 'ok',
      tool,
      result: { kind: 'digest', digest: reading.digest },
      text: renderDigest(reading.digest),
    };
  }

  async function location(): Promise<PageLocation> {
    return { url: page.url(), title: await page.title() };
  }

  function locator(handle: string): Locator {
    return page.locator(`[${REF_ATTRIBUTE}="${handle}"]`).first();
  }

  /** Finds the element behind a ref, or says in type why it cannot be acted on. */
  async function locate(handle: string): Promise<Lookup> {
    const expected = signatures.get(handle);
    if (expected === undefined) {
      return { ok: false, failure: { kind: 'stale-ref', ref: handle, reason: 'unknown' } };
    }
    const raw: unknown = await page.evaluate(
      resolveScript({
        attribute: REF_ATTRIBUTE,
        ref: handle,
        maxOptions: limits.maxOptions,
        maxChars: maxCharsFor(limits),
      }),
    );
    if (!isLocated(raw)) throw new DigestError('the page answered the ref lookup with something else');
    if (!raw.found) return { ok: false, failure: { kind: 'stale-ref', ref: handle, reason: 'missing' } };
    if (raw.signature !== expected) {
      return { ok: false, failure: { kind: 'stale-ref', ref: handle, reason: 'changed' } };
    }
    if (!raw.visible) {
      return {
        ok: false,
        failure: { kind: 'not-interactable', ref: handle, reason: `${quote(raw.label)} is no longer visible` },
      };
    }
    if (raw.disabled === true) {
      return {
        ok: false,
        failure: { kind: 'not-interactable', ref: handle, reason: `${quote(raw.label)} is disabled` },
      };
    }
    return { ok: true, element: raw };
  }

  /**
   * Gives a load the click may have started time to begin, then waits for it.
   *
   * The browser issues the navigation request as soon as a click commits to
   * one, before the site has answered, so that is the signal that a new
   * document is coming: the settle window only has to cover the browser's
   * own reaction, not the site's. Once a load has started it may take as
   * long as any navigation is allowed.
   */
  async function settle(): Promise<void> {
    const main = page.mainFrame();
    let commit: () => void = () => undefined;
    const committed = new Promise<void>((resolve) => {
      commit = resolve;
    });
    const onNavigated = (frame: Frame): void => {
      if (frame === main) commit();
    };
    page.on('framenavigated', onNavigated);
    try {
      const started = await Promise.race([
        committed.then(() => true),
        page
          .waitForEvent('request', {
            predicate: (request) => request.isNavigationRequest() && request.frame() === main,
            timeout: SETTLE_MS,
          })
          .then(
            () => true,
            () => false,
          ),
      ]);
      if (started) {
        let deadline: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          committed,
          new Promise<void>((resolve) => {
            deadline = setTimeout(resolve, navigationTimeoutMs);
          }),
        ]);
        clearTimeout(deadline);
      }
      await page.waitForLoadState('load', { timeout: navigationTimeoutMs }).catch(() => undefined);
    } finally {
      page.off('framenavigated', onNavigated);
    }
  }

  /** Whether the page is at the address the model asked for, however the browser spells it. */
  function landedOn(url: string): boolean {
    try {
      return new URL(page.url()).href === new URL(url).href;
    } catch {
      return false;
    }
  }

  /**
   * The navigation, seen through to the page when Chromium's error page from
   * the last wire failure lands in the middle of it: `settle` waits for that
   * page after a failure, but under load it can come later than the settle
   * window allows. The navigation the model asked for may still land after
   * the collision, or may have been cancelled with it and need asking again;
   * asked again, it can be interrupted by the first one landing late, which
   * leaves the page where it was asked to be.
   */
  async function goto(url: string): Promise<void> {
    const options = { timeout: navigationTimeoutMs, waitUntil: 'load' as const };
    try {
      await page.goto(url, options);
      return;
    } catch (error) {
      if (!interruptedByErrorPage(error)) throw error;
    }
    await settle();
    if (landedOn(url)) return;
    try {
      await page.goto(url, options);
    } catch (error) {
      if (!interruptedByNavigation(error) || !landedOn(url)) throw error;
      await page.waitForLoadState('load', { timeout: navigationTimeoutMs }).catch(() => undefined);
    }
  }

  async function navigate(args: ToolArgs<'navigate'>): Promise<ToolExecution> {
    try {
      await goto(args.url);
    } catch (error) {
      // A navigation that failed on the wire leaves Chromium committing its
      // own error page. Let that land before answering, or the model's next
      // navigate collides with it and fails for a reason that is not its own.
      await settle();
      throw error;
    }
    return read('navigate');
  }

  async function click(args: ToolArgs<'click'>): Promise<ToolExecution> {
    const lookup = await locate(args.ref);
    if (!lookup.ok) return failed('click', lookup.failure);
    await locator(args.ref).click({ timeout: actionTimeoutMs });
    await settle();
    return read('click');
  }

  async function type(args: ToolArgs<'type'>): Promise<ToolExecution> {
    const lookup = await locate(args.ref);
    if (!lookup.ok) return failed('type', lookup.failure);
    const { element } = lookup;
    if (element.kind !== 'textbox' && element.kind !== 'textarea') {
      return failed('type', {
        kind: 'not-interactable',
        ref: args.ref,
        reason: `${quote(element.label)} is a ${element.kind}, not a text field`,
      });
    }
    await locator(args.ref).fill(args.text, { timeout: actionTimeoutMs });
    return {
      kind: 'ok',
      tool: 'type',
      result: { kind: 'field', page: await location(), ref: args.ref, value: args.text },
      text: `Filled ${args.ref} (${quote(element.label)}) with ${quote(args.text)}.`,
    };
  }

  async function select(args: ToolArgs<'select'>): Promise<ToolExecution> {
    const lookup = await locate(args.ref);
    if (!lookup.ok) return failed('select', lookup.failure);
    const { element } = lookup;
    if (element.kind !== 'select') {
      return failed('select', {
        kind: 'not-interactable',
        ref: args.ref,
        reason: `${quote(element.label)} is a ${element.kind}, not a select`,
      });
    }
    const choices = element.options ?? [];
    const wanted = args.option.trim().toLowerCase();
    const match =
      choices.find((choice) => choice.value === args.option || choice.label === args.option) ??
      choices.find(
        (choice) =>
          choice.value.trim().toLowerCase() === wanted || choice.label.trim().toLowerCase() === wanted,
      );
    if (match === undefined) {
      return failed('select', {
        kind: 'no-such-option',
        ref: args.ref,
        option: args.option,
        options: choices.map((choice) => choice.label),
      });
    }
    await locator(args.ref).selectOption({ value: match.value }, { timeout: actionTimeoutMs });
    return {
      kind: 'ok',
      tool: 'select',
      result: { kind: 'field', page: await location(), ref: args.ref, value: match.label },
      text: `Selected ${quote(match.label)} in ${args.ref} (${quote(element.label)}).`,
    };
  }

  function withArgs<T extends ToolName>(
    tool: T,
    input: unknown,
    body: (args: ToolArgs<T>) => Promise<ToolExecution>,
  ): Promise<ToolExecution> {
    const parsed = parseToolInput(tool, input);
    return parsed.ok ? body(parsed.args) : Promise.resolve(failed(tool, parsed.failure));
  }

  function perform(tool: string, input: unknown): Promise<ToolExecution> {
    if (!isToolName(tool)) return Promise.resolve(failed(tool, { kind: 'unknown-tool', tool }));
    switch (tool) {
      case 'navigate':
        return withArgs('navigate', input, (args) => onPage('navigate', () => navigate(args), args.url));
      case 'click':
        return withArgs('click', input, (args) => onPage('click', () => click(args)));
      case 'type':
        return withArgs('type', input, (args) => onPage('type', () => type(args)));
      case 'select':
        return withArgs('select', input, (args) => onPage('select', () => select(args)));
      case 'read':
        return withArgs('read', input, () => onPage('read', () => read('read')));
      case 'ask_user':
        return withArgs('ask_user', input, (args) =>
          Promise.resolve({
            kind: 'ask',
            question: args.question,
            text: `Asked the person: ${quote(args.question)}. The task is paused until they answer; the answer arrives with the next run.`,
          }),
        );
      case 'declare_outcome':
        return withArgs('declare_outcome', input, (args) =>
          Promise.resolve({
            kind: 'outcome',
            status: args.status,
            detail: args.detail,
            text: `Outcome declared: ${args.status}. ${args.detail}`,
          }),
        );
    }
  }

  return {
    tools: BROWSER_TOOLS,
    async execute(tool, input) {
      const execution = await perform(tool, input);
      await log({
        name: `tool:${tool}`,
        outcome: outcomeOf(execution),
        detail: { input, ...trailDetail(execution) },
      });
      return execution;
    },
    get latest() {
      return latest;
    },
  };
}
