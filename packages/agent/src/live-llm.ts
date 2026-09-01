/**
 * The gate on the one test in this package that spends real model credit.
 *
 * Everything else here proves the loop against a scripted transport, which is
 * honest about what it covers and would not notice the thing that actually goes
 * wrong in production: a tool description the model reads differently than we
 * meant it, a schema it fills in the wrong shape, a phrasing it does not map to
 * any tool at all. That is what the live test is for, and why it needs its own
 * deliberate opt-in rather than running whenever a key happens to be around.
 *
 * The shape is the Solari live smoke's, on purpose - one convention for "this
 * test bills somebody", so nobody has to learn a second one.
 */

/** The Actions secret, and the local `.env` key, the live test authenticates with. */
export const ANTHROPIC_KEY_VARIABLE = 'ANTHROPIC_API_KEY';

/**
 * The explicit opt-in. A key on its own is not consent to spend it: without
 * this flag the suite skips even where a valid key is configured, so an
 * ordinary `pnpm check` never bills anyone.
 */
export const LIVE_LLM_FLAG = 'ANTHROPIC_LIVE_LLM';

/**
 * What counts as "yes". A list rather than a truthiness test, because
 * `ANTHROPIC_LIVE_LLM=0` reads as "no" to every human who writes it.
 */
const OPT_IN_VALUES: ReadonlySet<string> = new Set(['1', 'true', 'yes', 'on']);

/** Why the live test is not running, or `undefined` when it is. */
export function liveLlmSkipReason(env: Record<string, string | undefined>): string | undefined {
  const flag = (env[LIVE_LLM_FLAG] ?? '').trim().toLowerCase();
  if (!OPT_IN_VALUES.has(flag)) {
    return `${LIVE_LLM_FLAG} is not set to an opt-in value (1, true, yes, on), so the live chat-loop test was skipped rather than billed.`;
  }

  const apiKey = (env[ANTHROPIC_KEY_VARIABLE] ?? '').trim();
  if (apiKey === '') {
    return `${ANTHROPIC_KEY_VARIABLE} is not configured, so the live chat-loop test was skipped. Set it as a repository secret in CI, or in .env locally.`;
  }

  return undefined;
}
