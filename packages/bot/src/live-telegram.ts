/**
 * The gate on the one suite in the workspace that reaches a real phone.
 *
 * Every other proof of the bot answers Telegram at the API transformer and
 * plays the person from a script, which pins the routing exactly and cannot
 * notice the thing that actually goes wrong in production: a token Telegram
 * no longer honours, a chat the bot was never let into, a question that
 * arrives and a yes that never finds its way back to the task. The live
 * round-trip is for that, and it buzzes somebody's phone, so it needs its own
 * deliberate opt-in rather than running whenever a token happens to be around.
 *
 * The shape is the live-LLM gate's and the Solari smoke's, on purpose: one
 * convention for "this test reaches outside the machine", so nobody has to
 * learn a third one.
 */

/** The local `.env` key the bot authenticates with. Never in `.env.example`. */
export const TELEGRAM_TOKEN_VARIABLE = 'TELEGRAM_BOT_TOKEN';

/**
 * The explicit opt-in. A token on its own is not consent to message anyone:
 * without this flag the suite skips even where a valid token is configured,
 * so an ordinary `pnpm check` never reaches a phone.
 */
export const TELEGRAM_LIVE_FLAG = 'TELEGRAM_LIVE_ROUNDTRIP';

/**
 * The chat the live suite is to ask: the private chat between the bot and the
 * phone that will answer. Telegram numbers chats; the suite binds a throwaway
 * user to this one so the bot's ordinary binding gate lets the answer through.
 */
export const TELEGRAM_LIVE_CHAT_VARIABLE = 'TELEGRAM_LIVE_CHAT_ID';

/**
 * What counts as "yes". A list rather than a truthiness test, because
 * `TELEGRAM_LIVE_ROUNDTRIP=0` reads as "no" to every human who writes it.
 */
const OPT_IN_VALUES: ReadonlySet<string> = new Set(['1', 'true', 'yes', 'on']);

/** Why the live round-trip is not running, or `undefined` when it is. */
export function liveTelegramSkipReason(
  env: Record<string, string | undefined>,
): string | undefined {
  const flag = (env[TELEGRAM_LIVE_FLAG] ?? '').trim().toLowerCase();
  if (!OPT_IN_VALUES.has(flag)) {
    return `${TELEGRAM_LIVE_FLAG} is not set to an opt-in value (1, true, yes, on), so the live Telegram round-trip was skipped rather than sent to a phone.`;
  }

  const token = (env[TELEGRAM_TOKEN_VARIABLE] ?? '').trim();
  if (token === '') {
    return `${TELEGRAM_TOKEN_VARIABLE} is not configured, so the live Telegram round-trip was skipped. Put the bot's token in .env locally; it is never in .env.example.`;
  }

  const chatId = (env[TELEGRAM_LIVE_CHAT_VARIABLE] ?? '').trim();
  if (chatId === '') {
    return `${TELEGRAM_LIVE_CHAT_VARIABLE} is not configured, so the live Telegram round-trip has no phone to reach and was skipped. Set it in .env to the chat id of the phone that will answer.`;
  }
  if (!/^-?\d+$/u.test(chatId)) {
    return `${TELEGRAM_LIVE_CHAT_VARIABLE} is not a Telegram chat id (an integer), so the live Telegram round-trip was skipped rather than sent somewhere it cannot arrive.`;
  }

  return undefined;
}
