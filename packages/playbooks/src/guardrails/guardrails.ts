import { createHash } from 'node:crypto';

import type { MissionOutcome, TaskAnswer } from '@chief-of-staff/db';
import {
  withBrowser,
  type BrowserProvider,
  type BrowserRequest,
  type BrowserSession,
} from '@chief-of-staff/solari';
import type { APIResponse, BrowserContext, Frame, Page, Request, Route } from 'playwright';

import { checkUrl, type DomainAllowlist } from './allowlist.js';
import {
  describePaymentEvidence,
  detectPaymentPage,
  detectPaymentSubmission,
  parseSubmission,
  type PageSnapshot,
  type PaymentEvidence,
  type SubmissionSnapshot,
} from './payment-detector.js';
import { SNAPSHOT_SCRIPT, isPageSnapshot, snapshotPage } from './snapshot.js';

/**
 * The guardrail layer: safety as code, installed on the browser context and
 * enforced below whatever drives the page. A playbook step, or in s6 a model,
 * asks the browser for things; the browser refuses the ones the task is not
 * allowed, and the refusal ends the mission.
 *
 * Two rules. The domain allowlist: a top-level navigation - typed, clicked,
 * redirected to, or opened in a new tab - to a host outside the task's list
 * is aborted before the request leaves, and the task fails by `violation`
 * with the URL it tried. The payment gate: a mutating request that looks like
 * a payment - by what its body carries, or by what the page it came from
 * shows - is aborted, and the task parks on a question that names the page,
 * the target and the evidence. A confirmation admits exactly that submission,
 * by fingerprint, on the next run; a decline cancels the task; anything else
 * asks again. There is no field that turns either rule off.
 *
 * A stop is terminal for the session: nothing else leaves the context after
 * it, and the session is released under whatever was still driving the page.
 */

export interface GuardrailPolicy {
  /** The hosts this task may take the browser to. */
  readonly allowlist: DomainAllowlist;
  /**
   * Payment submissions the person has already said yes to, by fingerprint:
   * {@link paymentConfirmations} over the task's accepted answers. The only
   * way through the payment gate.
   */
  readonly confirmedPayments?: readonly string[];
}

export interface AllowlistViolation {
  readonly kind: 'allowlist';
  readonly attemptedUrl: string;
  readonly via: 'navigation' | 'redirect' | 'popup';
  /** The URL that answered with the redirect, for `via: 'redirect'`. */
  readonly redirectedFrom: string | undefined;
  /** Where the page was when it tried. */
  readonly from: string;
  readonly reason: 'host' | 'scheme' | 'unparseable';
}

export interface PaymentGate {
  readonly kind: 'payment';
  readonly fingerprint: string;
  readonly url: string;
  readonly method: string;
  readonly fieldNames: readonly string[];
  readonly evidence: readonly PaymentEvidence[];
  readonly page: { readonly url: string; readonly title: string };
}

export type GuardStop = AllowlistViolation | PaymentGate;

/** One request, in the terms the rules are written in. */
export interface RequestFacts {
  readonly url: string;
  readonly method: string;
  /** A navigation of a page's main frame, as opposed to a subresource or an embedded frame. */
  readonly topLevelNavigation: boolean;
  readonly redirectedFrom: string | undefined;
  /** Whether the page making the request was opened by another page. */
  readonly popup: boolean;
  readonly pageUrl: string;
  readonly pageTitle: string;
  readonly contentType: string | undefined;
  readonly body: string | undefined;
  /** The page the request came from, when it could be read. */
  readonly page: PageSnapshot | undefined;
}

export type Judgement =
  | { readonly action: 'continue' }
  | { readonly action: 'stop'; readonly stop: GuardStop };

const MUTATING: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Identifies a submission by where it goes and which fields it carries, not
 * by their values: the same form, sent again after a confirmation, is the
 * same submission even though the session cookie changed.
 */
export function paymentFingerprint(submission: SubmissionSnapshot): string {
  let target = submission.url;
  try {
    const parsed = new URL(submission.url);
    target = `${parsed.origin}${parsed.pathname}`;
  } catch {
    // Not a URL; fingerprinted as written.
  }
  const names = [...new Set(submission.fields.map((field) => field.name))].sort();
  return createHash('sha256')
    .update(`${submission.method} ${target}\n${names.join(',')}`)
    .digest('hex')
    .slice(0, 16);
}

/** The rules, over facts. Pure, so the unit tests can be exhaustive. */
export function judgeRequest(policy: GuardrailPolicy, facts: RequestFacts): Judgement {
  if (facts.topLevelNavigation) {
    const verdict = checkUrl(facts.url, policy.allowlist);
    if (!verdict.allowed) {
      return {
        action: 'stop',
        stop: {
          kind: 'allowlist',
          attemptedUrl: facts.url,
          via: facts.redirectedFrom !== undefined ? 'redirect' : facts.popup ? 'popup' : 'navigation',
          redirectedFrom: facts.redirectedFrom,
          from: facts.pageUrl,
          reason: verdict.reason,
        },
      };
    }
  }
  if (!MUTATING.has(facts.method.toUpperCase())) return { action: 'continue' };

  const submission = parseSubmission(facts.url, facts.method, facts.contentType, facts.body);
  const verdicts = [detectPaymentSubmission(submission)];
  if (facts.page !== undefined) verdicts.push(detectPaymentPage(facts.page));
  if (!verdicts.some((verdict) => verdict.payment)) return { action: 'continue' };

  const fingerprint = paymentFingerprint(submission);
  if ((policy.confirmedPayments ?? []).includes(fingerprint)) return { action: 'continue' };
  return {
    action: 'stop',
    stop: {
      kind: 'payment',
      fingerprint,
      url: facts.url,
      method: submission.method,
      fieldNames: [...new Set(submission.fields.map((field) => field.name))],
      evidence: verdicts.flatMap((verdict) => verdict.evidence),
      page: { url: facts.pageUrl, title: facts.pageTitle },
    },
  };
}

/** A page's own account of itself at the moment a form went out, handed up by the submit watcher. */
interface SubmitRecord {
  readonly snapshot: PageSnapshot;
  readonly at: number;
}

const SUBMIT_BINDING = '__chiefOfStaffGuardSubmit';
/** How long a submit-time snapshot stays paired with the navigation it preceded. */
const SUBMIT_WINDOW_MS = 15_000;
/** How long a live page read may take before the request is judged without it. */
const LIVE_READ_MS = 1_500;

/**
 * Submit-time snapshots by page, shared by every guard so that a context
 * guarded twice still feeds one cache. A page cannot be read while its own
 * navigation is held at the route - the read waits on a document that is
 * waiting on the read - so a submitting form's page is captured before, by
 * the page itself, and kept here until the new document commits.
 */
const SUBMISSIONS = new WeakMap<Page, SubmitRecord>();

/** Runs in every document: on any form submission, hand the page's snapshot up before it unloads. */
const SUBMIT_WATCHER = `addEventListener('submit', () => {
  try { window[${JSON.stringify(SUBMIT_BINDING)}](${SNAPSHOT_SCRIPT}); } catch (error) {}
}, true);`;

async function watchSubmissions(context: BrowserContext): Promise<void> {
  try {
    await context.exposeBinding(SUBMIT_BINDING, ({ page, frame }, snapshot: unknown) => {
      if (frame === page.mainFrame() && isPageSnapshot(snapshot)) {
        SUBMISSIONS.set(page, { snapshot, at: Date.now() });
      }
    });
  } catch {
    // Already watching: a second guard on the same context shares the cache.
  }
  await context.addInitScript(SUBMIT_WATCHER);
  const forget = (page: Page): void => {
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) SUBMISSIONS.delete(page);
    });
  };
  context.pages().forEach(forget);
  context.on('page', forget);
}

function frameOf(request: Request): Frame | undefined {
  try {
    return request.frame();
  } catch {
    // A popup's first navigation has no frame yet; Playwright throws rather than guess.
    return undefined;
  }
}

function pause(ms: number): Promise<undefined> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(undefined);
    }, ms);
  });
}

/**
 * The page behind a submission: the submit-time snapshot when the submission
 * navigates, a live read when it does not. Either may be missing, and a
 * missing page leaves the submission to be judged on its body alone.
 */
async function pageView(page: Page, navigating: boolean): Promise<PageSnapshot | undefined> {
  if (navigating) {
    let record = SUBMISSIONS.get(page);
    if (record === undefined) {
      await pause(30);
      record = SUBMISSIONS.get(page);
    }
    if (record === undefined || Date.now() - record.at > SUBMIT_WINDOW_MS) return undefined;
    return record.snapshot;
  }
  try {
    return await Promise.race([snapshotPage(page), pause(LIVE_READ_MS)]);
  } catch {
    return undefined;
  }
}

/** Reads a request while it is held at the route, without touching a page that is on its way out. */
async function gatherFacts(request: Request): Promise<RequestFacts> {
  const method = request.method();
  const mutating = MUTATING.has(method.toUpperCase());
  const common = {
    url: request.url(),
    method,
    redirectedFrom: request.redirectedFrom()?.url(),
    contentType: request.headers()['content-type'],
    body: mutating ? (request.postData() ?? undefined) : undefined,
  };
  const frame = frameOf(request);
  if (frame === undefined) {
    return {
      ...common,
      topLevelNavigation: request.isNavigationRequest(),
      popup: true,
      pageUrl: '',
      pageTitle: '',
      page: undefined,
    };
  }
  const page = frame.page();
  const topLevelNavigation = request.isNavigationRequest() && frame.parentFrame() === null;
  const view = mutating ? await pageView(page, topLevelNavigation) : undefined;
  return {
    ...common,
    topLevelNavigation,
    popup: topLevelNavigation && (await page.opener()) !== null,
    pageUrl: page.url(),
    pageTitle: view?.title ?? '',
    page: view,
  };
}

/** A hop the browser followed on its own. It has already left, so this is judged late - but never silently. */
function hopFacts(request: Request): RequestFacts | undefined {
  const from = request.redirectedFrom();
  if (from === null || !request.isNavigationRequest()) return undefined;
  const frame = frameOf(request);
  if (frame !== undefined && frame.parentFrame() !== null) return undefined;
  return {
    url: request.url(),
    method: request.method(),
    topLevelNavigation: true,
    redirectedFrom: from.url(),
    popup: frame === undefined,
    pageUrl: frame?.url() ?? '',
    pageTitle: '',
    contentType: undefined,
    body: undefined,
    page: undefined,
  };
}

async function abort(route: Route, reason: 'blockedbyclient' | 'failed' = 'blockedbyclient'): Promise<void> {
  try {
    await route.abort(reason);
  } catch {
    // The page is already gone; there is nothing left to refuse.
  }
}

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

function redirectTarget(response: APIResponse, from: string): string | undefined {
  const location = response.headers()['location'];
  if (location === undefined || !REDIRECT_STATUSES.has(response.status())) return undefined;
  try {
    return new URL(location, from).toString();
  } catch {
    return location;
  }
}

/** A document that goes where the redirect pointed - as a navigation of its own, so the rules see it. */
function hopDocument(target: string): string {
  const literal = JSON.stringify(target).replace(/</g, '\\u003c');
  return `<!doctype html><meta charset="utf-8"><script>location.replace(${literal})</script>`;
}

async function fulfill(route: Route, options: Parameters<Route['fulfill']>[0]): Promise<void> {
  try {
    await route.fulfill(options);
  } catch {
    // The page is already gone; there is nobody left to answer.
  }
}

/**
 * Serves a top-level navigation from this side, so that a redirect is judged
 * before its hop leaves: the browser does not route the requests it makes
 * while following a redirect, so it is not allowed to follow one. A redirect
 * that stays in the lane becomes a navigation of its own, which the rules see
 * like any other; one that leaves is refused with the hop unsent.
 */
async function serveNavigation(
  route: Route,
  facts: RequestFacts,
  admit: (facts: RequestFacts) => boolean,
): Promise<void> {
  let response: APIResponse;
  try {
    response = await route.fetch({ maxRedirects: 0 });
  } catch {
    await abort(route, 'failed');
    return;
  }
  const target = redirectTarget(response, facts.url);
  if (target === undefined) {
    await fulfill(route, { response });
    return;
  }
  const hop: RequestFacts = {
    ...facts,
    url: target,
    method: 'GET',
    redirectedFrom: facts.url,
    contentType: undefined,
    body: undefined,
    page: undefined,
  };
  if (!admit(hop)) {
    await abort(route);
    return;
  }
  await fulfill(route, {
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: hopDocument(target),
  });
}

export interface Guardrails {
  /** The first stop, once there is one. Nothing leaves the context after it. */
  readonly stop: GuardStop | undefined;
  readonly stopped: Promise<GuardStop>;
}

/**
 * Puts the rules on a context for the rest of its life. Every request the
 * context makes is held and judged: a subresource then goes on its way, a
 * top-level navigation is served from here so that its redirects are judged
 * too, and after the first stop everything is refused without judgement.
 */
export async function installGuardrails(
  context: BrowserContext,
  policy: GuardrailPolicy,
): Promise<Guardrails> {
  let stop: GuardStop | undefined;
  let announce: (stop: GuardStop) => void = () => undefined;
  const stopped = new Promise<GuardStop>((resolve) => {
    announce = resolve;
  });
  /** True when the request may go on. The first stop wins, and is announced once. */
  const admit = (facts: RequestFacts): boolean => {
    if (stop !== undefined) return false;
    const judgement = judgeRequest(policy, facts);
    if (judgement.action === 'stop') {
      stop = judgement.stop;
      announce(stop);
      return false;
    }
    return true;
  };
  await watchSubmissions(context);
  context.on('request', (request) => {
    const hop = hopFacts(request);
    if (hop !== undefined) admit(hop);
  });
  await context.route('**/*', async (route: Route, request: Request) => {
    if (request.serviceWorker() !== null) {
      await route.continue();
      return;
    }
    if (stop !== undefined) {
      await abort(route);
      return;
    }
    let facts: RequestFacts;
    try {
      facts = await gatherFacts(request);
    } catch {
      await abort(route);
      return;
    }
    if (!admit(facts)) {
      await abort(route);
      return;
    }
    if (!facts.topLevelNavigation) {
      await route.continue();
      return;
    }
    await serveNavigation(route, facts, admit);
  });
  return {
    get stop() {
      return stop;
    },
    stopped,
  };
}

export type GuardedOutcome<T> =
  | { readonly kind: 'completed'; readonly value: T }
  | { readonly kind: 'stopped'; readonly stop: GuardStop };

type Settled<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'threw'; readonly error: unknown };

/**
 * Runs `body` on a fresh page of a guarded session. A stop wins over whatever
 * the body was doing: the session is released under it, its pending calls
 * fail quietly, and the stop is what comes back. A body that finishes first
 * returns its value; one that throws first throws. The guard is handed to
 * the body too, so a body that does several things in turn can see a stop
 * between them rather than start the next thing on a released session.
 */
export async function runGuarded<T>(
  session: BrowserSession,
  policy: GuardrailPolicy,
  body: (page: Page, guard: Guardrails) => Promise<T>,
): Promise<GuardedOutcome<T>> {
  const guard = await installGuardrails(session.context, policy);
  const page = await session.newPage();
  const run: Promise<Settled<T>> = body(page, guard).then(
    (value) => ({ kind: 'value', value }),
    (error: unknown) => ({ kind: 'threw', error }),
  );
  const first = await Promise.race([run, guard.stopped.then(() => 'stopped' as const)]);
  if (first === 'stopped' || guard.stop !== undefined) {
    const stop = await guard.stopped;
    await session.release();
    return { kind: 'stopped', stop };
  }
  if (first.kind === 'threw') throw first.error;
  return { kind: 'completed', value: first.value };
}

/** Which session a run used, and whether the provider recorded it. What is stored on the task. */
export interface SessionEcho {
  readonly provider: string;
  readonly sessionId: string;
  readonly recording: boolean;
}

/** Every guarded session asks for a recording. The ask cannot be turned off; what came back is the echo. */
export function guardedRequest(request: BrowserRequest = {}): BrowserRequest {
  return { ...request, recording: true };
}

export interface GuardedSessionOptions {
  readonly provider: BrowserProvider;
  readonly policy: GuardrailPolicy;
  readonly request?: BrowserRequest;
}

export interface GuardedRun<T> {
  readonly outcome: GuardedOutcome<T>;
  readonly session: SessionEcho;
}

/**
 * Acquires a session, guards it, runs `body` on it, and releases it whatever
 * happens. The echo is handed to the body first, so a runner can put the
 * session on the task's row before anything else happens in it.
 */
export async function guardedSession<T>(
  options: GuardedSessionOptions,
  body: (page: Page, session: SessionEcho, guard: Guardrails) => Promise<T>,
): Promise<GuardedRun<T>> {
  return withBrowser(options.provider, guardedRequest(options.request), async (session) => {
    const echo: SessionEcho = {
      provider: options.provider.name,
      sessionId: session.meta.sessionId,
      recording: session.meta.recording,
    };
    const outcome = await runGuarded(session, options.policy, (page, guard) => body(page, echo, guard));
    return { outcome, session: echo };
  });
}

const GATE_TAG = /\[payment-gate ([0-9a-f]{16})\]/;
const AFFIRMATIVE = /^\s*(?:confirm(?:ed)?|yes|approve(?:d)?|ok(?:ay)?|go ahead)\s*[.!]*\s*$/i;

/** The question a parked task carries. Its last line is the tag a confirmation is matched by. */
export function paymentQuestion(gate: PaymentGate): string {
  const fields = gate.fieldNames.length === 0 ? '' : ` with ${gate.fieldNames.join(', ')}`;
  return [
    'Chief of Staff is about to submit what looks like a payment and needs your go-ahead.',
    `Page: ${gate.page.title === '' ? '(untitled)' : gate.page.title} (${gate.page.url})`,
    `Submission: ${gate.method} ${gate.url}${fields}`,
    `Why it looks like a payment: ${describePaymentEvidence(gate.evidence)}`,
    'Reply "confirm" to allow exactly this submission, or decline to cancel the task.',
    `[payment-gate ${gate.fingerprint}]`,
  ].join('\n');
}

/** The fingerprints of every payment the person has confirmed, read from the task's accepted answers. */
export function paymentConfirmations(answers: readonly TaskAnswer[]): string[] {
  const confirmed: string[] = [];
  for (const answer of answers) {
    const tag = GATE_TAG.exec(answer.question)?.[1];
    if (tag !== undefined && AFFIRMATIVE.test(answer.reply)) confirmed.push(tag);
  }
  return confirmed;
}

/** What a stop means for the mission: an allowlist violation fails it; a payment gate parks it. */
export function stopOutcome(stop: GuardStop): MissionOutcome {
  if (stop.kind === 'allowlist') {
    return {
      kind: 'failed',
      cause: 'violation',
      reason: `navigation to ${stop.attemptedUrl} is outside the task's allowlist`,
      detail: stop,
    };
  }
  return { kind: 'ask', question: paymentQuestion(stop) };
}
