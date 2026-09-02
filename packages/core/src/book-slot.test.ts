import { describe, expect, it } from 'vitest';

import { BOOK_SLOT_TASK_KIND, bookSlotInput, parseBookSlotInput, type BookSlotInput } from './book-slot.js';
import { TASK_KINDS } from './index.js';
import type { SlotCondition } from './watch/condition.js';

/**
 * The vocabulary the slot trigger writes and the booking playbook reads. It
 * round-trips through JSON (the task row's `input` column), and the reader
 * refuses anything the writer would not have produced.
 */

const CONDITION: SlotCondition = { kind: 'slot', site: 'fakedmv', applicant: { name: 'Ada Lovelace' }, auto_book: true };
const WATCH = { id: 'watch-1', url: 'https://dmv.test/appointments' };
const SLOT = { id: 'tue-0900', label: 'Tue 8 Sep, 09:00' };

const INPUT: BookSlotInput = {
  site: 'fakedmv',
  watchId: 'watch-1',
  url: 'https://dmv.test/appointments',
  slot: SLOT,
  applicant: { name: 'Ada Lovelace' },
  auto_book: true,
};

describe('bookSlotInput', () => {
  it('is a task kind the ledger knows', () => {
    expect(TASK_KINDS).toContain(BOOK_SLOT_TASK_KIND);
  });

  it('carries the site, the watch, the slot and the applicant, and nothing else', () => {
    expect(bookSlotInput(WATCH, CONDITION, SLOT)).toEqual(INPUT);
  });

  it('round-trips through JSON', () => {
    const stored: unknown = JSON.parse(JSON.stringify(bookSlotInput(WATCH, CONDITION, SLOT)));

    expect(parseBookSlotInput(stored)).toEqual(INPUT);
  });
});

describe('parseBookSlotInput', () => {
  it('drops fields the vocabulary does not have', () => {
    expect(
      parseBookSlotInput({ ...INPUT, slot: { ...SLOT, startsAt: 'later' }, applicant: { name: 'Ada' }, note: 'x' }),
    ).toEqual({ ...INPUT, applicant: { name: 'Ada' } });
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['an array', [INPUT]],
    ['no site', { ...INPUT, site: undefined }],
    ['a blank site', { ...INPUT, site: '' }],
    ['no watch', { ...INPUT, watchId: 3 }],
    ['a blank watch', { ...INPUT, watchId: '' }],
    ['no url', { ...INPUT, url: '' }],
    ['no slot', { ...INPUT, slot: null }],
    ['a slot with no label', { ...INPUT, slot: { id: 'tue-0900' } }],
    ['an applicant with no name', { ...INPUT, applicant: {} }],
    ['an applicant with extra fields', { ...INPUT, applicant: { name: 'Ada', email: 'ada@example.test' } }],
    ['a non-boolean auto_book', { ...INPUT, auto_book: 'yes' }],
  ])('refuses %s', (_label, value) => {
    expect(parseBookSlotInput(value)).toBeUndefined();
  });
});
