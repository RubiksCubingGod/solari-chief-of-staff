import { ApiError, ApiUnreachableError } from './api-client';

/**
 * What to tell the reader when a page could not be drawn from the API.
 *
 * Every page in this dashboard is a server component, and a server component
 * that throws renders nothing at all - so each of them has to decide, before
 * drawing, what to say when the API did not answer or refused. That decision is
 * the same on every page, and it is here so that it is the same by construction
 * rather than by three authors agreeing.
 *
 * There are exactly two things worth saying:
 *
 * - The API was not reachable, which is an outage and is not the reader's
 *   fault, so it is described rather than blamed on them.
 * - The API refused and said why, in which case its own words are better than
 *   anything this process could invent about a decision it did not make.
 *
 * Anything else is rethrown. A page state is for what the server said; a defect
 * in this process is not that, and folding it into a tidy banner would hide the
 * stack that says where it is.
 */
export function describeRefusal(error: unknown): string {
  if (error instanceof ApiUnreachableError) return 'the API did not answer';
  if (error instanceof ApiError) return error.message;
  throw error;
}
