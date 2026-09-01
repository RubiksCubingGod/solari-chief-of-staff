/**
 * Everything the bot says on its own behalf, in one place.
 *
 * They are constants rather than string literals at their call sites because
 * every one of them is asserted by a proof, and a reply whose wording the tests
 * restate is a reply the tests cannot actually be wrong about. Each refusal
 * says what happened and what to do next; none of them says which guess was
 * close, because a stranger sending codes is exactly who that would help.
 */

export const BINDING_CONFIRMED =
  'You are connected. Ask me for anything from here — watches, reminders, cancellations — in your own words.';

export const BINDING_ALREADY_DONE =
  'This chat is already connected to your account, so there was nothing to do. The code has been used up all the same.';

export const BINDING_CODE_UNKNOWN =
  'That code is not one I recognize. Codes are ten characters and come from your dashboard; check it and send `/start <code>` again.';

export const BINDING_CODE_EXPIRED =
  'That code has expired. Ask your dashboard for a new one and send `/start <code>` again — they are short-lived on purpose.';

export const BINDING_CODE_CONSUMED =
  'That code has already been used. Each one works exactly once; ask your dashboard for a new one.';

export const BINDING_CHAT_TAKEN =
  'This chat is already connected to a different account. Disconnect it from that account first — I will not move it on the strength of a code alone.';

export const BINDING_USER_TAKEN =
  'That account is already connected to a different chat. Disconnect it there first — I will not move it on the strength of a code alone.';

export const HOW_TO_BIND =
  'We have not met yet. Open your dashboard, ask it for a connection code, and send it here as `/start <code>`. Until then I cannot act on anything.';

/**
 * What a chat that has run out of tokens is told, once per notice window. It
 * names the limit rather than blaming the sender: the usual cause is a retry
 * loop somewhere, not a person typing quickly.
 */
export const RATE_LIMIT_NOTICE =
  'You are sending messages faster than I can handle them. I have paused this chat for a moment — everything you send meanwhile is ignored, so please resend anything that mattered.';

/**
 * What somebody who has just answered a question is told. It says where the
 * answer went rather than what will happen next, because what happens next is
 * the job's to decide and this bot does not know it yet.
 */
export const ANSWER_RECORDED =
  'Thanks - I have passed that back to the job that asked, and it will carry on from there.';

/**
 * The reply when the thing that should have answered could not. Deliberately
 * says nothing changed: after a failure somewhere in the middle, the question
 * a person actually has is whether their request half-happened.
 */
export const ASSISTANT_UNAVAILABLE =
  'Something went wrong on my side before I could deal with that, so nothing has changed. Please send it again in a moment.';
