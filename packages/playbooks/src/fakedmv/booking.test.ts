import type { BookSlotInput } from '@chief-of-staff/core';
import type { Task, TaskAnswer } from '@chief-of-staff/db';
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';

import type { PlaybookContext, PlaybookStep } from '../runner/playbook.js';
import { answerTo } from '../runner/runner.js';
import { bookingOutcome, confirmQuestion, confirms, fakedmvBooking, parseBookingAnswer } from './booking.js';

/**
 * The playbook's own words and readings, off the page: what it asks, what it
 * takes for a yes, what it makes of the site's answers, and the gate step,
 * which touches no page at all. The steps that do are proven against the
 * fixture in `fakedmv.integration.test.ts`.
 */

const ORIGIN = 'http://127.0.0.1:4304';
const NOW = new Date('2026-09-02T10:00:00Z');

const INPUT: BookSlotInput = {
  site: 'fakedmv',
  watchId: 'watch-1',
  url: `${ORIGIN}/appointments`,
  slot: { id: 'Tue 8 Sep, 09:00', label: 'Tue 8 Sep, 09:00' },
  applicant: { name: 'Ada Lovelace' },
  auto_book: false,
};

const QUESTION =
  'Fakedmv has an appointment open: Tue 8 Sep, 09:00. Book it for Ada Lovelace? Reply yes to book it, or no to leave it.';

function task(input: unknown): Task {
  return {
    id: 'task-1',
    userId: 'user-1',
    kind: 'book_slot',
    input,
    status: 'running',
    mode: 'playbook',
    playbookId: null,
    solariSessionId: null,
    recordingUrl: null,
    jobId: null,
    result: null,
    createdAt: NOW,
    finishedAt: null,
  };
}

const answered = (reply: string): TaskAnswer => ({
  questionId: 'q1',
  question: QUESTION,
  reply,
  answeredAt: '2026-09-02T10:01:00.000Z',
});

/** An open playbook's context: no connection, no credential. */
function context(input: unknown, answers: readonly TaskAnswer[] = []): PlaybookContext {
  return {
    task: task(input),
    input: input as Readonly<Record<string, unknown>>,
    answers,
    answerTo: (question) => answerTo(answers, question),
  };
}

function stepNamed(name: string): PlaybookStep {
  const step = fakedmvBooking({ origin: ORIGIN }).steps.find((candidate) => candidate.name === name);
  if (step === undefined) throw new Error(`no step ${name}`);
  return step;
}

/** The gate touches no page. */
const noPage = {} as Page;

interface CalendarPage {
  readonly blocked?: boolean;
  readonly calendar?: boolean;
  readonly listed?: boolean;
}

/** Enough of a page for the re-check: the shell marker, the calendar list, and the slot's entry. */
function calendarPage(options: CalendarPage): { readonly page: Page; readonly visited: string[] } {
  const visited: string[] = [];
  const count = (present: boolean): (() => Promise<number>) => () => Promise.resolve(present ? 1 : 0);
  const page = {
    goto: (url: string) => {
      visited.push(url);
      return Promise.resolve(null);
    },
    getByText: () => ({}),
    locator: (selector: string) => {
      switch (selector) {
        case 'meta[name="fixture-state"]':
          return {
            count: count(options.blocked === true),
            first: () => ({ getAttribute: () => Promise.resolve('fixture-state:blocked') }),
          };
        case 'ul.dmv-slots':
          return { count: count(options.calendar !== false) };
        case 'li.dmv-slot':
          return { filter: () => ({ count: count(options.listed !== false) }) };
        default:
          throw new Error(`the fake page has no ${selector}`);
      }
    },
  } as unknown as Page;
  return { page, visited };
}

describe('fakedmvBooking', () => {
  it('is book_slot on fakedmv, open, at the origin, in three steps', () => {
    const playbook = fakedmvBooking({ origin: `${ORIGIN}/` });
    expect(playbook).toMatchObject({
      id: 'fakedmv.book_slot',
      site: 'fakedmv',
      action: 'book_slot',
      access: 'open',
      origin: ORIGIN,
      siteDomain: '127.0.0.1:4304',
      allowlist: ['127.0.0.1'],
    });
    expect(playbook.steps.map((step) => step.name)).toEqual(['availability', 'confirm', 'book']);
  });

  it('takes another id when told', () => {
    expect(fakedmvBooking({ origin: ORIGIN, id: 'dmv-staging.book' }).id).toBe('dmv-staging.book');
  });

  it('leaves a bad origin for definePlaybook to refuse', () => {
    expect(() => fakedmvBooking({ origin: 'not a url' })).toThrow('origin not a url is not a URL');
  });
});

describe('confirmQuestion', () => {
  it('names the slot and the applicant, and says what the replies mean', () => {
    expect(confirmQuestion(INPUT)).toBe(QUESTION);
  });
});

describe('confirms', () => {
  it.each(['yes', 'Yes', ' YES ', 'y', 'yes please', 'Yes!', 'ok', 'okay.', 'book it', 'confirm', 'go ahead', 'sure'])(
    'takes %j for a yes',
    (reply) => {
      expect(confirms(reply)).toBe(true);
    },
  );

  it.each(['no', 'No thanks', '', 'nope', 'yes but later', 'maybe', 'book tomorrow'])('takes %j for a no', (reply) => {
    expect(confirms(reply)).toBe(false);
  });
});

describe('parseBookingAnswer', () => {
  it('reads a booking', () => {
    expect(
      parseBookingAnswer('{"slotId":"tue-0900","name":"Ada","bookedAt":"2026-09-02T10:00:00.000Z","reference":"DMV-000001"}'),
    ).toEqual({ kind: 'booked', reference: 'DMV-000001', slotId: 'tue-0900', bookedAt: '2026-09-02T10:00:00.000Z' });
  });

  it('reads a refusal, with or without its message', () => {
    expect(parseBookingAnswer('{"code":"gone","message":"that appointment is gone"}')).toEqual({
      kind: 'refusal',
      code: 'gone',
      message: 'that appointment is gone',
    });
    expect(parseBookingAnswer('{"code":"transient"}')).toEqual({ kind: 'refusal', code: 'transient', message: '' });
  });

  it.each([
    ['text', 'Service unavailable'],
    ['a list', '[1]'],
    ['an object that is neither', '{"error":"slotId and name must be non-empty strings"}'],
    ['a booking with no reference', '{"slotId":"tue-0900","name":"Ada","bookedAt":"now"}'],
  ])('keeps %s as text', (_named, text) => {
    expect(parseBookingAnswer(text)).toEqual({ kind: 'other', text });
  });
});

describe('bookingOutcome', () => {
  const LABEL = 'Tue 8 Sep, 09:00';

  it('is done with the reference on the trail and in the result when the site booked', () => {
    expect(
      bookingOutcome({ kind: 'booked', reference: 'DMV-000001', slotId: 'tue-0900', bookedAt: '2026-09-02T10:00:00.000Z' }, LABEL),
    ).toEqual({
      kind: 'done',
      detail: { reference: 'DMV-000001', slotId: 'tue-0900', bookedAt: '2026-09-02T10:00:00.000Z' },
      result: { reference: 'DMV-000001', bookedAt: '2026-09-02T10:00:00.000Z' },
    });
  });

  it('is the slot-gone refusal when the site says gone', () => {
    expect(bookingOutcome({ kind: 'refusal', code: 'gone', message: '' }, LABEL)).toEqual({
      kind: 'refused',
      reason: 'fakedmv turned the booking away: Tue 8 Sep, 09:00 is gone',
      detail: { code: 'slot-gone' },
    });
  });

  it('is a failure, not a refusal, when the site says transient, or something it has no word for', () => {
    expect(bookingOutcome({ kind: 'refusal', code: 'transient', message: 'try again shortly' }, LABEL)).toEqual({
      kind: 'failed',
      reason: 'fakedmv could not take the booking right now (transient)',
    });
    expect(bookingOutcome({ kind: 'refusal', code: 'closed', message: '' }, LABEL)).toEqual({
      kind: 'failed',
      reason: 'fakedmv refused the booking (closed)',
    });
  });

  it('is a failure with an excerpt of whatever else the site answered', () => {
    expect(bookingOutcome({ kind: 'other', text: '  Service\n unavailable ' }, LABEL)).toEqual({
      kind: 'failed',
      reason: 'fakedmv answered the booking with something else: Service unavailable',
    });
    const long = 'x'.repeat(100);
    expect(bookingOutcome({ kind: 'other', text: long }, LABEL)).toEqual({
      kind: 'failed',
      reason: `fakedmv answered the booking with something else: ${'x'.repeat(77)}...`,
    });
  });
});

describe('the availability step', () => {
  const availability = stepNamed('availability');

  it('goes to the calendar and is done when the slot is listed', async () => {
    const { page, visited } = calendarPage({});
    await expect(availability.run(page, context(INPUT))).resolves.toEqual({
      kind: 'done',
      detail: { slot: 'Tue 8 Sep, 09:00' },
    });
    expect(visited).toEqual([`${ORIGIN}/appointments`]);
  });

  it('refuses as slot-gone when the slot is not listed', async () => {
    await expect(availability.run(calendarPage({ listed: false }).page, context(INPUT))).resolves.toEqual({
      kind: 'refused',
      reason: 'fakedmv no longer offers Tue 8 Sep, 09:00',
      detail: { code: 'slot-gone' },
    });
  });

  it('fails on the blocked shell, and on a page with no calendar', async () => {
    await expect(availability.run(calendarPage({ blocked: true }).page, context(INPUT))).resolves.toEqual({
      kind: 'failed',
      reason: 'fakedmv is showing its blocked shell',
    });
    await expect(availability.run(calendarPage({ calendar: false }).page, context(INPUT))).resolves.toEqual({
      kind: 'failed',
      reason: 'fakedmv did not show its calendar',
    });
  });

  it('fails without touching the page when the task input is not a booking', async () => {
    const { page, visited } = calendarPage({});
    await expect(availability.run(page, context({ site: 'fakedmv' }))).resolves.toEqual({
      kind: 'failed',
      reason: 'the task input is not a book_slot input',
    });
    expect(visited).toEqual([]);
  });
});

describe('the confirm step', () => {
  const confirm = stepNamed('confirm');

  it('is done as auto when the watch said auto_book, asking nobody', async () => {
    await expect(confirm.run(noPage, context({ ...INPUT, auto_book: true }))).resolves.toEqual({
      kind: 'done',
      detail: { confirmed: 'auto' },
    });
  });

  it('asks the question while nobody has answered it', async () => {
    await expect(confirm.run(noPage, context(INPUT))).resolves.toEqual({ kind: 'ask', question: QUESTION });
  });

  it('is done as person on a yes', async () => {
    await expect(confirm.run(noPage, context(INPUT, [answered('Yes!')]))).resolves.toEqual({
      kind: 'done',
      detail: { confirmed: 'person' },
    });
  });

  it('refuses as not-confirmed on anything else', async () => {
    await expect(confirm.run(noPage, context(INPUT, [answered('no')]))).resolves.toEqual({
      kind: 'refused',
      reason: 'the person did not confirm booking Tue 8 Sep, 09:00',
      detail: { code: 'not-confirmed' },
    });
  });
});
