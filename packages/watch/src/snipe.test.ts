import { bookingDedupKey, type BookSlotInput, type TransitionEventPayload } from '@chief-of-staff/core';
import type { Task } from '@chief-of-staff/db';
import { describe, expect, it } from 'vitest';

import { SNIPE_STEP, bookingEventFor, outcomeOf, snipeConsequence, snipeStep, type SnipeConsequence } from './snipe.js';

/**
 * The consequence table off the database: what each way a booking task can
 * end does to its watch, and the event and trail step each earns. The
 * transaction, the sweep and the hook are proven on the real worker in
 * `snipe.integration.test.ts`.
 */

const SLOT = { id: 'Tue 8 Sep, 09:00', label: 'Tue 8 Sep, 09:00' };

const INPUT: BookSlotInput = {
  site: 'fakedmv',
  watchId: 'watch-1',
  url: 'http://127.0.0.1:4304/appointments',
  slot: SLOT,
  applicant: { name: 'Ada Lovelace' },
  auto_book: false,
};

const NOW = new Date('2026-09-02T10:00:00Z');

function task(status: Task['status'], result: unknown = null): Pick<Task, 'id' | 'userId' | 'status' | 'result'> {
  return { id: 'task-1', userId: 'user-1', status, result };
}

function transition(cause: TransitionEventPayload['cause'], detail: unknown = null): TransitionEventPayload {
  return { from: 'running', to: 'failed', cause, detail };
}

const refused = (reason: string, code: string): TransitionEventPayload =>
  transition('refused', { reason, detail: { code } });

describe('snipeConsequence', () => {
  it('is booked, with the reference, when the task succeeded with one', () => {
    expect(
      snipeConsequence(task('succeeded', { reference: 'DMV-000001', bookedAt: '2026-09-02T10:00:00.000Z', playbook: 'fakedmv.book_slot' }), transition('succeeded'), SLOT),
    ).toEqual({ kind: 'booked', reference: 'DMV-000001', bookedAt: '2026-09-02T10:00:00.000Z' });
  });

  it('pauses for attention when the task succeeded without a reference: booked means booked', () => {
    expect(snipeConsequence(task('succeeded', { playbook: 'fakedmv.book_slot' }), transition('succeeded'), SLOT)).toEqual({
      kind: 'paused',
      reason: 'the booking task succeeded without a confirmation reference for Tue 8 Sep, 09:00',
    });
  });

  it('re-arms with the baseline cleared when the slot was gone', () => {
    expect(snipeConsequence(task('failed'), refused('availability: fakedmv no longer offers Tue 8 Sep, 09:00', 'slot-gone'), SLOT)).toEqual({
      kind: 'rearm',
      clearBaseline: true,
      reason: 'availability: fakedmv no longer offers Tue 8 Sep, 09:00',
    });
  });

  it('re-arms with the baseline kept when the person did not confirm, declined, or never answered', () => {
    expect(snipeConsequence(task('failed'), refused('confirm: the person did not confirm booking Tue 8 Sep, 09:00', 'not-confirmed'), SLOT)).toEqual({
      kind: 'rearm',
      clearBaseline: false,
      reason: 'confirm: the person did not confirm booking Tue 8 Sep, 09:00',
    });
    expect(snipeConsequence(task('cancelled'), { from: 'waiting_user', to: 'cancelled', cause: 'declined', detail: { questionId: 'q1' } }, SLOT)).toEqual({
      kind: 'rearm',
      clearBaseline: false,
      reason: 'the person declined to book Tue 8 Sep, 09:00',
    });
    expect(snipeConsequence(task('failed'), { from: 'waiting_user', to: 'failed', cause: 'timeout', detail: { questionId: 'q1', expiresAt: 'x' } }, SLOT)).toEqual({
      kind: 'rearm',
      clearBaseline: false,
      reason: 'nobody answered before the deadline, so Tue 8 Sep, 09:00 was not booked',
    });
  });

  it('re-arms a cancellation it has no words for, still keeping the baseline', () => {
    expect(snipeConsequence(task('cancelled'), undefined, SLOT)).toEqual({
      kind: 'rearm',
      clearBaseline: false,
      reason: 'the booking of Tue 8 Sep, 09:00 was cancelled',
    });
  });

  it('pauses, with the reason, on a refusal it has no word for, an error, a violation, or an orphan', () => {
    expect(snipeConsequence(task('failed'), refused('the site said something new', 'closed'), SLOT)).toEqual({
      kind: 'paused',
      reason: 'the site said something new',
    });
    expect(snipeConsequence(task('failed'), transition('error', { reason: 'availability: fakedmv is showing its blocked shell' }), SLOT)).toEqual({
      kind: 'paused',
      reason: 'availability: fakedmv is showing its blocked shell',
    });
    expect(snipeConsequence(task('failed'), transition('violation', { reason: 'left its lane' }), SLOT)).toEqual({
      kind: 'paused',
      reason: 'left its lane',
    });
    expect(snipeConsequence(task('failed'), transition('orphaned', { jobId: 'j1', state: 'failed' }), SLOT)).toEqual({
      kind: 'paused',
      reason: 'the booking of Tue 8 Sep, 09:00 failed (orphaned)',
    });
    expect(snipeConsequence(task('failed'), undefined, SLOT)).toEqual({
      kind: 'paused',
      reason: 'the booking of Tue 8 Sep, 09:00 failed',
    });
  });

  it('is nothing while the task is not terminal', () => {
    for (const status of ['queued', 'running', 'waiting_user'] as const) {
      expect(snipeConsequence(task(status), transition('started'), SLOT)).toBeUndefined();
    }
  });
});

describe('outcomeOf', () => {
  it('names what became of the watch', () => {
    expect(outcomeOf({ kind: 'booked', reference: 'DMV-000001', bookedAt: 'now' })).toBe('booked');
    expect(outcomeOf({ kind: 'rearm', clearBaseline: true, reason: 'gone' })).toBe('rearmed');
    expect(outcomeOf({ kind: 'paused', reason: 'blocked' })).toBe('paused');
  });
});

describe('bookingEventFor', () => {
  const booked: SnipeConsequence = { kind: 'booked', reference: 'DMV-000001', bookedAt: '2026-09-02T10:00:00.000Z' };

  it('carries the watch, the person, the task, the slot, the outcome and the reference, keyed by task and outcome', () => {
    expect(bookingEventFor(INPUT, task('succeeded'), booked, NOW)).toEqual({
      type: 'booking',
      watchId: 'watch-1',
      userId: 'user-1',
      url: 'http://127.0.0.1:4304/appointments',
      occurredAt: '2026-09-02T10:00:00.000Z',
      dedupKey: bookingDedupKey('watch-1', 'task-1', 'booked'),
      taskId: 'task-1',
      slot: SLOT,
      outcome: 'booked',
      reference: 'DMV-000001',
      reason: 'Tue 8 Sep, 09:00 is booked: reference DMV-000001',
    });
  });

  it('has no reference and the consequence\'s own reason otherwise', () => {
    expect(bookingEventFor(INPUT, task('failed'), { kind: 'rearm', clearBaseline: true, reason: 'gone' }, NOW)).toMatchObject({
      dedupKey: bookingDedupKey('watch-1', 'task-1', 'rearmed'),
      outcome: 'rearmed',
      reference: null,
      reason: 'gone',
    });
    expect(bookingEventFor(INPUT, task('failed'), { kind: 'paused', reason: 'blocked' }, NOW)).toMatchObject({
      dedupKey: bookingDedupKey('watch-1', 'task-1', 'paused'),
      outcome: 'paused',
      reference: null,
      reason: 'blocked',
    });
  });
});

describe('snipeStep', () => {
  it('records the outcome and the words, and for a re-arm whether the row moved', () => {
    expect(snipeStep(INPUT, { kind: 'booked', reference: 'DMV-000001', bookedAt: 'now' }, false)).toEqual({
      name: SNIPE_STEP,
      outcome: 'booked',
      detail: { watchId: 'watch-1', reason: 'Tue 8 Sep, 09:00 is booked: reference DMV-000001' },
    });
    expect(snipeStep(INPUT, { kind: 'rearm', clearBaseline: false, reason: 'declined' }, true)).toEqual({
      name: SNIPE_STEP,
      outcome: 'rearmed',
      detail: { watchId: 'watch-1', reason: 'declined', clearBaseline: false, moved: true },
    });
    expect(snipeStep(INPUT, { kind: 'paused', reason: 'blocked' }, false)).toEqual({
      name: SNIPE_STEP,
      outcome: 'paused',
      detail: { watchId: 'watch-1', reason: 'blocked' },
    });
  });
});
