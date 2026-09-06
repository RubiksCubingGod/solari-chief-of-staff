/**
 * The one-time code that binds a Telegram chat to a user (ARCHITECTURE §10).
 *
 * The format lives here rather than with either side of the exchange because
 * both sides have to agree on it: the API issues codes, the bot reads them back
 * out of `/start`, and a disagreement between the two is a code that can be
 * issued but never redeemed.
 */

/**
 * Crockford's base32: the digits and the uppercase letters, minus `I`, `L`, `O`
 * and `U`. The first three are dropped because a code is read off a screen and
 * typed into a phone, where they are indistinguishable from `1`, `1` and `0`;
 * `U` is dropped so a random code cannot spell something unfortunate.
 */
export const BINDING_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 32^10, around 10^15 codes, against a few minutes of life and a rate limit. */
export const BINDING_CODE_LENGTH = 10;

/** The characters Crockford's alphabet drops, and what a reader meant by them. */
const CONFUSABLE: Readonly<Record<string, string>> = { I: '1', L: '1', O: '0' };

/**
 * Turns what somebody typed into the code that was issued: case folded, spaces
 * and the hyphens people add to keep their place removed, and the three
 * confusable letters mapped onto the digits they were misread from. It does not
 * validate — `isBindingCode` does that, on the result of this.
 */
export function normalizeBindingCode(input: string): string {
  return [...input.toUpperCase()]
    .filter((character) => !/[\s-]/u.test(character))
    .map((character) => CONFUSABLE[character] ?? character)
    .join('');
}

/** Whether a string is a code as issued — after `normalizeBindingCode`. */
export function isBindingCode(value: string): boolean {
  if (value.length !== BINDING_CODE_LENGTH) return false;
  return [...value].every((character) => BINDING_CODE_ALPHABET.includes(character));
}
