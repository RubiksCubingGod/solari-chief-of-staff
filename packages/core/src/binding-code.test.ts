import { describe, expect, it } from 'vitest';

import {
  BINDING_CODE_ALPHABET,
  BINDING_CODE_LENGTH,
  isBindingCode,
  normalizeBindingCode,
} from './binding-code.js';

describe('the binding code format', () => {
  it('excludes the characters people confuse when reading a code aloud', () => {
    expect(BINDING_CODE_ALPHABET).not.toMatch(/[ILOU]/u);
    // Crockford's base32, and the reason the alphabet is worth naming at all:
    // a code is typed by hand from a screen into a phone.
    expect(BINDING_CODE_ALPHABET).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ');
    expect(new Set(BINDING_CODE_ALPHABET).size).toBe(BINDING_CODE_ALPHABET.length);
  });

  it('is long enough that guessing one is not a strategy', () => {
    // 32^10 is about 10^15. At the rate a chat may send messages, exhausting
    // even a millionth of that outlives the code's few minutes of life.
    expect(BINDING_CODE_LENGTH).toBe(10);
  });

  it('accepts a code exactly as it was issued', () => {
    const code = 'ABCDEFGHJK';

    expect(normalizeBindingCode(code)).toBe(code);
    expect(isBindingCode(code)).toBe(true);
  });

  it('forgives the ways a person retypes a code', () => {
    // Lowercase, the hyphens a reader adds to keep their place, and the four
    // letters Crockford maps onto digits.
    expect(normalizeBindingCode('  abcde-fghjk ')).toBe('ABCDEFGHJK');
    expect(normalizeBindingCode('oil0123456')).toBe('0110123456');
    expect(normalizeBindingCode('OIL0123456')).toBe('0110123456');
  });

  it('refuses anything that is not a code, rather than guessing at it', () => {
    expect(isBindingCode('')).toBe(false);
    expect(isBindingCode('ABCDEFGHJ')).toBe(false);
    expect(isBindingCode('ABCDEFGHJKL')).toBe(false);
    // Normalization is the caller's job and has already happened by here, so a
    // lowercase code at this point is a bug, not an input to be repaired.
    expect(isBindingCode('abcdefghjk')).toBe(false);
    expect(isBindingCode('ABCDEFGH!K')).toBe(false);
  });

  it('normalizes to something the guard then accepts, for any valid code', () => {
    // The two halves have to agree, or a code could be issued that no amount
    // of retyping will ever be recognized.
    const issued = 'Z9Y8X7W6V5';

    expect(isBindingCode(normalizeBindingCode(issued.toLowerCase()))).toBe(true);
  });
});
