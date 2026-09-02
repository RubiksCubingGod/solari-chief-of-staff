import {
  BOOK_SLOT_TASK_KIND,
  parseBookSlotInput,
  type BookSlotInput,
  type BookSlotRefusal,
} from '@chief-of-staff/core';
import type { Locator, Page } from 'playwright';

import {
  definePlaybook,
  type Playbook,
  type PlaybookContext,
  type PlaybookStep,
  type StepOutcome,
} from '../runner/playbook.js';

/**
 * The booking playbook for fakedmv: the arm a slot watch queues when the
 * calendar shows the slot it was told to look for. Three steps, re-walked
 * from the top whenever the task comes back with an answer:
 *
 * - `availability` re-checks the calendar for the slot the watch saw. A slot
 *   the site no longer offers is a refusal (`slot-gone`), not a failure: the
 *   watch re-arms and waits for the next one, and nothing on the site moved.
 * - `confirm` asks the person once, unless the watch said `auto_book`. A no
 *   is a refusal too (`not-confirmed`). A decline never reaches the step: the
 *   engine cancels the task on it.
 * - `book` fills the applicant's name into the slot's own form, submits it,
 *   and reads the site's answer: a booking, whose reference the task keeps as
 *   its result, or one of the site's two refusals.
 *
 * Because every run starts at `availability`, the re-check after the person's
 * yes is automatic: a slot yanked while they were deciding is found gone in
 * the fresh session before anything is filled in.
 *
 * The playbook signs in to nothing. The DMV has no account behind its
 * calendar, so the playbook is `open`: no site connection, no profile, a
 * plain session.
 */

/** The question at the gate. A reply is matched to exactly this text, so it names the slot. */
export function confirmQuestion(input: BookSlotInput): string {
  return (
    `Fakedmv has an appointment open: ${input.slot.label}. ` +
    `Book it for ${input.applicant.name}? Reply yes to book it, or no to leave it.`
  );
}

const YES: ReadonlySet<string> = new Set([
  'yes',
  'y',
  'yes please',
  'yep',
  'yeah',
  'ok',
  'okay',
  'book',
  'book it',
  'confirm',
  'confirmed',
  'go',
  'go ahead',
  'do it',
  'sure',
]);

/**
 * Whether a reply to the gate's question is a yes. Anything else is a no: a
 * booking is not something to make on a reply that only might have meant yes.
 */
export function confirms(reply: string): boolean {
  return YES.has(reply.trim().toLowerCase().replace(/[.!]+$/u, '').trim());
}

/** What fakedmv answers a booking form with, as the playbook reads it off the page. */
export type BookingAnswer =
  | { readonly kind: 'booked'; readonly reference: string; readonly slotId: string; readonly bookedAt: string }
  | { readonly kind: 'refusal'; readonly code: string; readonly message: string }
  | { readonly kind: 'other'; readonly text: string };

/**
 * Reads the JSON fakedmv answers its booking form with. Anything that is not
 * a booking or one of its refusals is kept as text, so an unexpected page
 * ends up in a failure reason rather than being mistaken for either.
 */
export function parseBookingAnswer(text: string): BookingAnswer {
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
  const reference = record['reference'];
  const slotId = record['slotId'];
  const bookedAt = record['bookedAt'];
  if (typeof reference === 'string' && typeof slotId === 'string' && typeof bookedAt === 'string') {
    return { kind: 'booked', reference, slotId, bookedAt };
  }
  const code = record['code'];
  if (typeof code === 'string') {
    const message = record['message'];
    return { kind: 'refusal', code, message: typeof message === 'string' ? message : '' };
  }
  return { kind: 'other', text };
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= 80 ? flat : `${flat.slice(0, 77)}...`;
}

function refused(reason: string, code: BookSlotRefusal): StepOutcome {
  return { kind: 'refused', reason, detail: { code } };
}

/**
 * The `book` step's outcome for what the site answered. A booking is done,
 * with the reference and the time for the task's result; `gone` is the slot
 * refusal, the same one the re-check makes; `transient` is a failure, because
 * the slot is still there and the watch has nothing to re-arm for.
 */
export function bookingOutcome(answer: BookingAnswer, label: string): StepOutcome {
  switch (answer.kind) {
    case 'booked':
      return {
        kind: 'done',
        detail: { reference: answer.reference, slotId: answer.slotId, bookedAt: answer.bookedAt },
        result: { reference: answer.reference, bookedAt: answer.bookedAt },
      };
    case 'refusal':
      if (answer.code === 'gone') return refused(`fakedmv turned the booking away: ${label} is gone`, 'slot-gone');
      if (answer.code === 'transient') {
        return { kind: 'failed', reason: 'fakedmv could not take the booking right now (transient)' };
      }
      return { kind: 'failed', reason: `fakedmv refused the booking (${answer.code})` };
    case 'other':
      return { kind: 'failed', reason: `fakedmv answered the booking with something else: ${excerpt(answer.text)}` };
  }
}

/* Reading the fixture's pages. */

/** The marker fakedmv's blocked shell carries, mirrored from the fixture's page shell. */
const BLOCKED_SHELL_STATE = 'fixture-state:blocked';

const BLOCKED: StepOutcome = { kind: 'failed', reason: 'fakedmv is showing its blocked shell' };

const NOT_A_BOOKING: StepOutcome = { kind: 'failed', reason: 'the task input is not a book_slot input' };

async function blocked(page: Page): Promise<boolean> {
  const marker = page.locator('meta[name="fixture-state"]');
  if ((await marker.count()) === 0) return false;
  return (await marker.first().getAttribute('content')) === BLOCKED_SHELL_STATE;
}

function bodyText(page: Page): Promise<string> {
  return page.locator('body').innerText();
}

/** The calendar entry for exactly this slot, by the label the watch saw. */
function slotEntry(page: Page, label: string): Locator {
  return page.locator('li.dmv-slot').filter({ has: page.getByText(label, { exact: true }) });
}

/** A step that reads the task's input as a booking, and refuses to run on anything else. */
function bookingStep(
  name: string,
  run: (page: Page, input: BookSlotInput, context: PlaybookContext) => Promise<StepOutcome>,
): PlaybookStep {
  return {
    name,
    run(page, context) {
      const input = parseBookSlotInput(context.input);
      return input === undefined ? Promise.resolve(NOT_A_BOOKING) : run(page, input, context);
    },
  };
}

/* The steps, in the order the site walks them. */

function bookingSteps(base: string): PlaybookStep[] {
  const availability = bookingStep('availability', async (page, input) => {
    await page.goto(`${base}/appointments`);
    if (await blocked(page)) return BLOCKED;
    if ((await page.locator('ul.dmv-slots').count()) === 0) {
      return { kind: 'failed', reason: 'fakedmv did not show its calendar' };
    }
    if ((await slotEntry(page, input.slot.label).count()) === 0) {
      return refused(`fakedmv no longer offers ${input.slot.label}`, 'slot-gone');
    }
    return { kind: 'done', detail: { slot: input.slot.label } };
  });

  const confirm = bookingStep('confirm', (_page, input, { answerTo }) => {
    if (input.auto_book) return Promise.resolve({ kind: 'done', detail: { confirmed: 'auto' } });
    const question = confirmQuestion(input);
    const reply = answerTo(question);
    if (reply === undefined) return Promise.resolve({ kind: 'ask', question });
    return Promise.resolve(
      confirms(reply)
        ? { kind: 'done', detail: { confirmed: 'person' } }
        : refused(`the person did not confirm booking ${input.slot.label}`, 'not-confirmed'),
    );
  });

  const book = bookingStep('book', async (page, input) => {
    // The page is the calendar `availability` left; the entry is looked up
    // again rather than remembered, because a step keeps nothing between runs.
    const entry = slotEntry(page, input.slot.label);
    if ((await entry.count()) === 0) return refused(`fakedmv no longer offers ${input.slot.label}`, 'slot-gone');
    await entry.locator('input[name="name"]').fill(input.applicant.name);
    await entry.getByRole('button', { name: 'Book this appointment' }).click();
    await page.waitForLoadState('load');
    return bookingOutcome(parseBookingAnswer(await bodyText(page)), input.slot.label);
  });

  return [availability, confirm, book];
}

export interface FakedmvBookingOptions {
  /** Where the fixture listens, e.g. `http://127.0.0.1:4304`. */
  readonly origin: string;
  /** Overrides the default id, `fakedmv.book_slot`. */
  readonly id?: string;
}

/** The registered playbook: `book_slot` on `fakedmv`, at the fixture's origin, signing in to nothing. */
export function fakedmvBooking(options: FakedmvBookingOptions): Playbook {
  // A bad origin is left for `definePlaybook` to refuse in its own words.
  const base = URL.canParse(options.origin) ? new URL(options.origin).origin : options.origin;
  return definePlaybook({
    ...(options.id === undefined ? {} : { id: options.id }),
    site: 'fakedmv',
    action: BOOK_SLOT_TASK_KIND,
    access: 'open',
    origin: options.origin,
    steps: bookingSteps(base),
  });
}
