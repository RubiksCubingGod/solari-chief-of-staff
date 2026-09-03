import type { UserResolution } from './user-io.js';

/**
 * What a person meant by a short reply (auto-cancel-path spec: the confirm gate).
 *
 * The confirm gate asks a yes-or-no question and the chat carries the reply
 * back word for word, so both ends need one reading of "yes" and "no": a
 * "nope" the bot passed along as an answer would otherwise reach a gate that
 * reads anything but "yes" as a refusal, or worse, one that reads anything
 * but "no" as consent. The vocabulary is deliberately small and literal. A
 * reply that is not plainly one or the other is `unclear`, and the gate asks
 * again rather than guessing, because the action behind the question is not
 * one to guess about. "Cancel" is in neither list on purpose: to a question
 * about cancelling something it means both.
 */

export type Consent = 'yes' | 'no' | 'unclear';

const YES: ReadonlySet<string> = new Set([
  'yes',
  'y',
  'yeah',
  'yep',
  'yup',
  'aye',
  'sure',
  'ok',
  'okay',
  'go ahead',
  'go for it',
  'do it',
  'yes do it',
  'please do',
  'yes please',
  'confirm',
  'confirmed',
  'affirmative',
  'absolutely',
  'proceed',
  'go on',
]);

const NO: ReadonlySet<string> = new Set([
  'no',
  'n',
  'nope',
  'nah',
  'no thanks',
  'no thank you',
  'negative',
  'never mind',
  'nevermind',
  'leave it',
  'leave it alone',
  'leave it as it is',
  'leave it as is',
  'do not',
  "don't",
  "don't do it",
  'do not do it',
  'stop',
  'not now',
  'no way',
]);

/**
 * The reply as the lists spell it: lower case, one space between words, the
 * punctuation a person types at the end of a word taken off. A question mark
 * is kept, because "yes?" is not a yes.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’`]/gu, "'")
    .replace(/[.,!;:"]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function listed(words: string): Consent | undefined {
  if (YES.has(words)) return 'yes';
  if (NO.has(words)) return 'no';
  return undefined;
}

export function readConsent(text: string): Consent {
  const words = normalize(text);
  // "Yes, please" and "please, no" are the listed word with its manners on.
  return listed(words) ?? listed(words.replace(/^please /u, '').replace(/ please$/u, '')) ?? 'unclear';
}

/**
 * What a reply becomes on its way to a task's ledger. A plain no is a
 * decline, which cancels the task without running anything; everything else
 * is carried as an answer, in the person's own words, for the mission to
 * read - the gate included, which is where an unclear reply is asked about.
 */
export function resolutionOf(text: string): UserResolution {
  return readConsent(text) === 'no' ? { kind: 'decline' } : { kind: 'answer', reply: text };
}
