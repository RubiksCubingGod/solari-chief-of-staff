/**
 * What the pause control is allowed to tell the reader afterwards.
 *
 * The route that performs the write cannot render anything: it is a form post
 * that answers 303, so whatever it learned has to survive a redirect and be
 * said by the page. The obvious carrier is the query string, and the obvious
 * thing to put in it is the API's own sentence - which is exactly what this
 * module refuses to do.
 *
 * A query parameter is not evidence. Anyone can hand a reader
 * `/watches?pause=Your+card+was+declined,+call+555-0100` and this dashboard
 * would render it in its own voice, under its own heading, styled as its own
 * alert. The read pages do print the API's words, and that is safe because they
 * came back from the API inside the same request that is drawing the page;
 * these did not. So the wire carries a token from a closed set and the sentence
 * is chosen here, which makes the reachable set of alert text a property of
 * this file rather than of whoever composed the link.
 *
 * `/login?sent=1` is the same decision, made for the same reason and already
 * accepted in this dashboard - it is why that page's confirmation is one fixed
 * sentence rather than anything the request supplied.
 *
 * What that costs is real and worth stating: a refusal the API explained ("that
 * watch does not exist") reaches the reader as the general sentence below. The
 * reader's next move is the same either way, and the list they land on is
 * re-read from the API, so the page around the alert already shows them the
 * truth the refusal was about.
 */

/** The query parameter the route redirects with, and the page reads back. */
export const PAUSE_OUTCOME_PARAMETER = 'pause';

const OUTCOMES = {
  /** The API was asked and did not do it - it refused, or it did not answer. */
  failed:
    'That watch could not be changed. The list below is what the API currently says about it.',
  /** The form never reached the API: it named something the domain does not have. */
  rejected:
    'That watch could not be changed: the form asked for a status this dashboard does not have.',
} as const;

export type PauseOutcome = keyof typeof OUTCOMES;

/** Where the route sends a reader whose pause did not happen. */
export function watchesPathWithOutcome(outcome: PauseOutcome): string {
  return `/watches?${PAUSE_OUTCOME_PARAMETER}=${outcome}`;
}

/**
 * The sentence for a token off the wire, or nothing at all.
 *
 * Nothing is the answer for an unknown token, so a crafted or stale link is
 * indistinguishable from an ordinary visit to `/watches` rather than being
 * reported as an error nobody caused. `Object.hasOwn` rather than a lookup, so
 * `?pause=toString` is unknown too.
 */
export function describePauseOutcome(value: string | string[] | undefined): string | undefined {
  const token = Array.isArray(value) ? value[0] : value;
  if (token === undefined) return undefined;
  return Object.hasOwn(OUTCOMES, token) ? OUTCOMES[token as PauseOutcome] : undefined;
}
