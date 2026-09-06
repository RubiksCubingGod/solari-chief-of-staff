import type { Page } from 'playwright';

import {
  definePlaybook,
  type Playbook,
  type PlaybookContext,
  type PlaybookStep,
  type StepOutcome,
} from '../runner/playbook.js';

/**
 * The cancellation playbook for fakegym, the fixture gym whose cancellation
 * flow has everything a real one uses to lose an engine: a sign-in, a
 * retention detour, two are-you-sure pages that refuse to be skipped, and a
 * confirmation code that only the member's inbox knows.
 *
 * The playbook never learns that code. When it reaches the gate without an
 * answer it asks; the engine parks the task and releases the browser, and a
 * later run walks the whole flow again from a fresh session with the reply.
 * Every step is written to be re-walked: the site keeps its own progress per
 * session, so signing in again and clicking through again is the only honest
 * way back to the gate, and the site answers it idempotently.
 *
 * Credentials come from the runner: a Solari profile, which this site has no
 * way to honour yet, or a password from a proof-only source. A profile the
 * site does not recognise is reported as "reconnect this site" rather than
 * turned into a request for a password, because passwords are never stored.
 */

export const CODE_QUESTION =
  'Fakegym emailed you a confirmation code to cancel the membership. What is the code?';
export const CODE_RETRY_QUESTION =
  'Fakegym refused that confirmation code. Please check the email again: what is the code?';

/** What a fakegym form answers with, as the playbook reads it off the page. */
export type SiteAnswer =
  | { readonly kind: 'status'; readonly status: string; readonly next?: string }
  | { readonly kind: 'refusal'; readonly code: string; readonly message: string }
  | { readonly kind: 'other'; readonly text: string };

/**
 * Reads the JSON fakegym answers its forms with. Anything that is not one of
 * its two shapes is kept as text, so an unexpected page ends up in a failure
 * reason rather than being mistaken for a refusal.
 */
export function parseSiteAnswer(text: string): SiteAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'other', text };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'other', text };
  }
  const record = parsed as Record<string, unknown>;
  const status = record['status'];
  if (typeof status === 'string') {
    const next = record['next'];
    return typeof next === 'string' ? { kind: 'status', status, next } : { kind: 'status', status };
  }
  const code = record['code'];
  if (typeof code === 'string') {
    const message = record['message'];
    return { kind: 'refusal', code, message: typeof message === 'string' ? message : '' };
  }
  return { kind: 'other', text };
}

/** A failure reason that says what the site actually did about `what`. */
export function describeAnswer(what: string, answer: SiteAnswer): string {
  switch (answer.kind) {
    case 'refusal':
      return `fakegym refused ${what} (${answer.code})`;
    case 'status':
      return `fakegym answered ${what} with status ${answer.status}`;
    case 'other':
      return `fakegym answered ${what} with something else: ${excerpt(answer.text)}`;
  }
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= 80 ? flat : `${flat.slice(0, 77)}...`;
}

export interface CodeAttempt {
  readonly code: string;
  /** Whether this is the second code the person gave, after the site refused the first. */
  readonly retried: boolean;
}

/**
 * The code to submit, if the person has given one. The reply to the retry
 * question wins over the reply to the first, because the first is the one the
 * site already refused.
 */
export function codeToTry(answerTo: PlaybookContext['answerTo']): CodeAttempt | undefined {
  const retry = answerTo(CODE_RETRY_QUESTION);
  if (retry !== undefined) return { code: retry.trim(), retried: true };
  const first = answerTo(CODE_QUESTION);
  return first === undefined ? undefined : { code: first.trim(), retried: false };
}

/* Reading the fixture's pages. */

/** The marker fakegym's blocked shell carries, mirrored from the fixture's page shell. */
const BLOCKED_SHELL_STATE = 'fixture-state:blocked';

const BLOCKED: StepOutcome = { kind: 'failed', reason: 'fakegym is showing its blocked shell' };

async function blocked(page: Page): Promise<boolean> {
  const marker = page.locator('meta[name="fixture-state"]');
  if ((await marker.count()) === 0) return false;
  return (await marker.first().getAttribute('content')) === BLOCKED_SHELL_STATE;
}

function bodyText(page: Page): Promise<string> {
  return page.locator('body').innerText();
}

function pathOf(page: Page): string {
  return new URL(page.url()).pathname;
}

async function present(page: Page, testId: string): Promise<boolean> {
  return (await page.getByTestId(testId).count()) > 0;
}

/** Presses a submit button and reads what the site answered, once that answer has loaded. */
async function submit(page: Page, testId: string): Promise<SiteAnswer> {
  await page.getByTestId(testId).click();
  await page.waitForLoadState('load');
  return parseSiteAnswer(await bodyText(page));
}

async function memberStatus(page: Page): Promise<string> {
  return (await page.getByTestId('member-status').innerText()).trim();
}

/** What the page at hand says, for a step that expected something else there. */
async function unexpectedPage(page: Page, what: string): Promise<StepOutcome> {
  return { kind: 'failed', reason: describeAnswer(what, parseSiteAnswer(await bodyText(page))) };
}

/* The steps, in the order the site walks them. */

function cancellationSteps(base: string): PlaybookStep[] {
  const login: PlaybookStep = {
    name: 'login',
    async run(page, { credential }) {
      await page.goto(`${base}/member`);
      if (await blocked(page)) return BLOCKED;
      if (pathOf(page) === '/member') {
        return { kind: 'done', detail: { status: await memberStatus(page), signedIn: 'already' } };
      }
      if (pathOf(page) !== '/login') return unexpectedPage(page, 'the member page');
      if (credential === undefined) {
        // Only an open playbook runs without one, and this is not one; the
        // guard is here so the type says so too.
        return { kind: 'failed', reason: 'fakegym needs a signed-in session; connect this site' };
      }
      if (credential.kind === 'profile') {
        // The site did not recognise the profile's session. Asking the person
        // for a password is not an option; reconnecting the site is.
        return { kind: 'failed', reason: 'fakegym asked for a full sign-in; reconnect this site', reconnect: true };
      }
      await page.getByTestId('email').fill(credential.username);
      await page.getByTestId('password').fill(credential.password);
      const answer = await submit(page, 'sign-in');
      if (pathOf(page) === '/member') {
        return { kind: 'done', detail: { status: await memberStatus(page), signedIn: 'now' } };
      }
      return { kind: 'failed', reason: describeAnswer('the credentials', answer) };
    },
  };

  const retention: PlaybookStep = {
    name: 'retention',
    async run(page) {
      await page.goto(`${base}/cancel/step-1`);
      if (await blocked(page)) return BLOCKED;
      if (!(await present(page, 'cancel-step-1'))) return unexpectedPage(page, 'the retention offer');
      const answer = await submit(page, 'continue-cancellation');
      if (answer.kind === 'status' && answer.status === 'retained') {
        // The site won: the membership is now marked retained, which is a
        // terminal state of its own, not a hint to try the offer again.
        return { kind: 'failed', reason: 'fakegym kept the membership (retained)' };
      }
      if (answer.kind !== 'status' || answer.next === undefined) {
        return { kind: 'failed', reason: describeAnswer('declining the offer', answer) };
      }
      return { kind: 'done', detail: { next: answer.next } };
    },
  };

  const areYouSure: PlaybookStep = {
    name: 'are-you-sure',
    async run(page) {
      let next: string | undefined;
      for (const step of [2, 3]) {
        const label = `are-you-sure step ${String(step)}`;
        await page.goto(`${base}/cancel/step-${String(step)}`);
        if (await blocked(page)) return BLOCKED;
        if (!(await present(page, `cancel-step-${String(step)}`))) return unexpectedPage(page, label);
        const answer = await submit(page, 'continue-cancellation');
        if (answer.kind !== 'status' || answer.next === undefined) {
          return { kind: 'failed', reason: describeAnswer(label, answer) };
        }
        next = answer.next;
      }
      return { kind: 'done', detail: { next } };
    },
  };

  const confirmationCode: PlaybookStep = {
    name: 'confirmation-code',
    async run(page, { answerTo }) {
      const attempt = codeToTry(answerTo);
      if (attempt === undefined) return { kind: 'ask', question: CODE_QUESTION };
      await page.goto(`${base}/cancel/confirm`);
      if (await blocked(page)) return BLOCKED;
      if (!(await present(page, 'cancel-confirm'))) return unexpectedPage(page, 'the confirmation page');
      await page.getByTestId('confirmation-code').fill(attempt.code);
      const answer = await submit(page, 'confirm-cancellation');
      if (answer.kind === 'status' && answer.status === 'cancelled') {
        return { kind: 'done', detail: { status: answer.status, attempts: attempt.retried ? 2 : 1 } };
      }
      if (answer.kind === 'refusal' && answer.code === 'wrong-code') {
        // One more chance, then the failure names both refusals: a person may
        // misread the email once, but a site that refuses twice is not going to
        // be worn down by a third guess.
        return attempt.retried
          ? { kind: 'failed', reason: 'fakegym refused the confirmation code twice' }
          : { kind: 'ask', question: CODE_RETRY_QUESTION };
      }
      return { kind: 'failed', reason: describeAnswer('the confirmation code', answer) };
    },
  };

  return [login, retention, areYouSure, confirmationCode];
}

export interface FakegymCancellationOptions {
  /** Where the fixture listens, e.g. `http://127.0.0.1:4303`. */
  readonly origin: string;
  /** Overrides the default id, `fakegym.cancel`. */
  readonly id?: string;
}

/** The registered playbook: `cancel` on `fakegym`, at the fixture's origin. */
export function fakegymCancellation(options: FakegymCancellationOptions): Playbook {
  // A bad origin is left for `definePlaybook` to refuse in its own words.
  const base = URL.canParse(options.origin) ? new URL(options.origin).origin : options.origin;
  return definePlaybook({
    ...(options.id === undefined ? {} : { id: options.id }),
    site: 'fakegym',
    action: 'cancel',
    origin: options.origin,
    steps: cancellationSteps(base),
  });
}
