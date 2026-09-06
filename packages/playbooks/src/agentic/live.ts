/**
 * The gate on the tests in this package that spend real model credit.
 *
 * The scripted transport proves what the loop does with what the model says;
 * it cannot notice a page the model reads differently than we meant, a tool
 * it fills in the wrong shape, or a brief it does not follow. That is what
 * the live smoke is for, and why it needs a deliberate opt-in rather than
 * running whenever a key happens to be around. The variables and the words
 * are the ones `packages/agent` and the Solari smoke use - one convention for
 * "this test bills somebody", so nobody has to learn a second one.
 */

/** The Actions secret, and the local `.env` key, the live tests authenticate with. */
export const ANTHROPIC_KEY_VARIABLE = 'ANTHROPIC_API_KEY';

/**
 * The explicit opt-in. A key on its own is not consent to spend it: without
 * this flag a live suite skips even where a valid key is configured, so an
 * ordinary `pnpm check` never bills anyone. `scripts/live-llm.mjs` sets it.
 */
export const LIVE_LLM_FLAG = 'ANTHROPIC_LIVE_LLM';

/**
 * What counts as "yes". A list rather than a truthiness test, because
 * `ANTHROPIC_LIVE_LLM=0` reads as "no" to every human who writes it.
 */
const OPT_IN_VALUES: ReadonlySet<string> = new Set(['1', 'true', 'yes', 'on']);

/** Why `what` is not running, or `undefined` when it is. */
export function liveLlmSkipReason(
  env: Readonly<Record<string, string | undefined>>,
  what: string,
): string | undefined {
  const flag = (env[LIVE_LLM_FLAG] ?? '').trim().toLowerCase();
  if (!OPT_IN_VALUES.has(flag)) {
    return `${LIVE_LLM_FLAG} is not set to an opt-in value (1, true, yes, on), so ${what} was skipped rather than billed.`;
  }

  const apiKey = (env[ANTHROPIC_KEY_VARIABLE] ?? '').trim();
  if (apiKey === '') {
    return `${ANTHROPIC_KEY_VARIABLE} is not configured, so ${what} was skipped. Set it as a repository secret in CI, or in .env locally.`;
  }

  return undefined;
}
