import { describe, expect, it } from 'vitest';

import { readConsent, resolutionOf } from './consent.js';

/**
 * One reading of "yes" and "no", shared by the confirm gate and the chat that
 * carries replies to it. The lists are small on purpose; what matters most
 * here is what they refuse to read.
 */

describe('readConsent', () => {
  it('reads the plain ways of saying yes', () => {
    for (const reply of ['yes', 'Yes', 'YES', 'y', 'yeah', 'yep', 'ok', 'okay', 'sure']) {
      expect(readConsent(reply), reply).toBe('yes');
    }
    for (const reply of ['go ahead', 'do it', 'confirm', 'yes please', 'please do']) {
      expect(readConsent(reply), reply).toBe('yes');
    }
  });

  it('reads the plain ways of saying no', () => {
    for (const reply of ['no', 'No', 'n', 'nope', 'nah', 'no thanks', 'never mind']) {
      expect(readConsent(reply), reply).toBe('no');
    }
    for (const reply of ['leave it', 'leave it as it is', "don't", 'do not', 'stop', 'not now']) {
      expect(readConsent(reply), reply).toBe('no');
    }
  });

  it('forgives the punctuation and spacing a person types, but not a question mark', () => {
    expect(readConsent('Yes!')).toBe('yes');
    expect(readConsent(' yes, please. ')).toBe('yes');
    expect(readConsent('Nope.')).toBe('no');
    expect(readConsent('leave   it   alone')).toBe('no');
    expect(readConsent('don’t')).toBe('no');
    // "yes?" is a question back, not an answer.
    expect(readConsent('yes?')).toBe('unclear');
  });

  it('is unclear about anything that is not plainly one or the other', () => {
    for (const reply of [
      '',
      '   ',
      'the annual one',
      'yes but not the annual one',
      'no, wait, yes',
      'maybe',
      'yes no',
      'not sure',
    ]) {
      expect(readConsent(reply), JSON.stringify(reply)).toBe('unclear');
    }
  });

  it('does not read "cancel" either way, because to a question about cancelling it means both', () => {
    expect(readConsent('cancel')).toBe('unclear');
    expect(readConsent('cancel it')).toBe('unclear');
  });
});

describe('resolutionOf', () => {
  it('turns a plain no into a decline', () => {
    expect(resolutionOf('no')).toEqual({ kind: 'decline' });
    expect(resolutionOf('Nope!')).toEqual({ kind: 'decline' });
  });

  it('carries everything else as an answer in the person’s own words', () => {
    expect(resolutionOf('yes')).toEqual({ kind: 'answer', reply: 'yes' });
    expect(resolutionOf(' Yes, please. ')).toEqual({ kind: 'answer', reply: ' Yes, please. ' });
    expect(resolutionOf('the annual one')).toEqual({ kind: 'answer', reply: 'the annual one' });
  });
});
