/**
 * What the chat loop says when the model does not get to say it.
 *
 * Each of these replaces the model's own words rather than adding to them, so
 * they are written the way the assistant talks: plain, specific about what did
 * and did not happen, and never blaming the person who sent the message.
 */

/**
 * The per-message tool budget ran out with the model still working. It is
 * deliberately vague about *what* was left undone, because the loop does not
 * know - and specific about the one thing it does know, which is that nothing
 * more will happen unless the user asks again.
 */
export const TOOL_BUDGET_SPENT =
  'That turned into more steps than I take on one message, so I stopped. ' +
  'Anything I had already done is done - send me the rest and I will pick it up.';

/** Nothing answered from the model's side, so the turn produced no judgement at all. */
export const LLM_UNAVAILABLE =
  'I could not reach my thinking just now, so I have not acted on that. Try me again in a minute.';

/**
 * The loop finished without the model saying anything - a turn cut off by its
 * token limit, most often. Rare, but a reply of no words at all is not something
 * a chat transport can send, so there has to be something here.
 */
export const NO_REPLY_PRODUCED =
  'I did not manage to put an answer together for that one. Ask me again?';
