/**
 * What the connect controls may tell the reader afterwards.
 *
 * The routes under `app/connect` are form posts that answer 303, so whatever
 * they learned has to cross a redirect, and `watches/pause-outcome.ts` makes
 * the case for how: the wire carries a token from a closed set and the
 * sentence is chosen here. The case is sharper on this page than on that one.
 * A query parameter is not evidence, and this is the page where a person is
 * about to log in somewhere - a crafted `/connect?connect=Enter+your+password`
 * rendered in this dashboard's voice is precisely the sentence the whole
 * design exists to never say.
 */

/** The query parameter the routes redirect with, and the page reads back. */
export const CONNECT_OUTCOME_PARAMETER = 'connect';

const OUTCOMES = {
  /** The person confirmed, and the API wrote the row. */
  connected: 'Connected. Tasks on that site will now sign in as you.',
  /** The person gave up; the profile made for the attempt is gone. */
  cancelled: 'Cancelled. The profile made for that attempt has been deleted.',
  /** Never sent: the form carried nothing to connect to. */
  rejected: 'Type the site as a host, such as gym.example.com, before pressing connect.',
  /** The API has no vendor to mint profiles with. An operator sets a key; nothing the reader types helps. */
  unavailable:
    'Connecting a site is not switched on: the server has no browser vendor key. An operator has to set one.',
  /** The API was asked and did not do it - it refused, or it did not answer. */
  failed:
    'That did not go through. The rows below are what the API currently holds; start again from there.',
} as const;

export type ConnectOutcome = keyof typeof OUTCOMES;

/** Every token a route may redirect with, for the test that reads them back. */
export const CONNECT_OUTCOMES = Object.keys(OUTCOMES) as readonly ConnectOutcome[];

/** Where the routes send a reader once the attempt is over, one way or another. */
export function connectPathWithOutcome(outcome: ConnectOutcome): string {
  return `/connect?${CONNECT_OUTCOME_PARAMETER}=${outcome}`;
}

/**
 * The sentence for a token off the wire, or nothing at all. `Object.hasOwn`
 * rather than a lookup, so `?connect=toString` is as unknown as any other
 * string this file did not write.
 */
export function describeConnectOutcome(value: string | string[] | undefined): string | undefined {
  const token = Array.isArray(value) ? value[0] : value;
  if (token === undefined) return undefined;
  return Object.hasOwn(OUTCOMES, token) ? OUTCOMES[token as ConnectOutcome] : undefined;
}
