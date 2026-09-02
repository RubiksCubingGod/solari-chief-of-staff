import { isWatchStatus } from '@chief-of-staff/core';

import { createApiClient, sessionCookieCredential } from '../../../api-client';
import { describeRefusal } from '../../../api-refusal';
import { loadWebConfig } from '../../../config';
import { watchesPathWithOutcome, type PauseOutcome } from '../../../watches/pause-outcome';

/**
 * The one write this read-only dashboard performs: pausing a watch, or starting
 * it again.
 *
 * Same origin, like the sign-in form, and for the same reason - the browser
 * posts to the page it is already on and the server talks to the API, so no
 * cross-origin write and no CORS. The session travels as the browser's own
 * cookie, forwarded unread, which means this route cannot pause a watch the
 * person driving it does not own even if it were asked to: the API settles
 * ownership, and answers a stranger's watch as one that does not exist.
 *
 * Every exit is the same 303 back to the list, carrying what happened. That is
 * the whole failure design: a route handler that throws renders nothing, and
 * there is no error boundary under `app/` to catch it, so an unguarded refusal
 * here is Next's default 500 - a blank page, on the one control the reader
 * pressed, at exactly the moment the API is unwell. The read pages next door
 * spent that effort saying so instead, and this one has to as well.
 */
export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const id = form.get('id');
  const status = form.get('status');

  if (!(typeof id === 'string' && typeof status === 'string' && isWatchStatus(status))) {
    // Never sent, so never a refusal the API made. Reported as its own outcome
    // rather than the bare redirect this used to be: that answer is identical
    // to the one a pause that worked gives, which leaves the reader looking at
    // an unchanged row with nothing on the page to say why it did not move.
    return backToTheList('rejected');
  }

  const client = createApiClient({
    baseUrl: loadWebConfig().apiBaseUrl,
    credential: sessionCookieCredential(request.headers.get('cookie') ?? ''),
  });

  try {
    await client.setWatchStatus(id, status);
  } catch (error) {
    // Classified, not swallowed. `describeRefusal` is the one place that decides
    // whether the API said this or this process is broken, and it rethrows the
    // second kind - so a defect here still arrives as a stack that says where it
    // is. Its sentence is deliberately not what the reader gets; `pause-outcome`
    // explains why this carries a token rather than prose off the wire.
    describeRefusal(error);
    return backToTheList('failed');
  }

  return backToTheList();
}

/**
 * 303 so the browser follows with a GET and re-reads the list from the API. The
 * new status is then something the page was told, not something this route
 * assumed worked - and on the failures above, the row the reader is looking at
 * is the API's current answer rather than this route's guess about it.
 *
 * Relative, and that is load-bearing rather than tidy. An absolute URL here has
 * to name a host, and the only host this process can name is the one it thinks
 * it is - `request.url` reports `localhost` whatever the browser actually
 * dialled. A browser that reached the dashboard by any other name, `127.0.0.1`
 * included, would follow that redirect onto a different origin, and the session
 * cookie is host-only: it would arrive signed out and be bounced to the sign-in
 * page by the guard. A relative `Location` leaves the browser on the host it
 * already chose, which is the only one known to work.
 */
function backToTheList(outcome?: PauseOutcome): Response {
  return new Response(null, {
    status: 303,
    headers: { location: outcome === undefined ? '/watches' : watchesPathWithOutcome(outcome) },
  });
}
