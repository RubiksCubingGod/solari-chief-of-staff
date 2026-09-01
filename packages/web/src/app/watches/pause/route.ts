import { isWatchStatus } from '@chief-of-staff/core';

import { createApiClient, sessionCookieCredential } from '../../../api-client';
import { loadWebConfig } from '../../../config';

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
 */
export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const id = form.get('id');
  const status = form.get('status');

  if (typeof id === 'string' && typeof status === 'string' && isWatchStatus(status)) {
    const client = createApiClient({
      baseUrl: loadWebConfig().apiBaseUrl,
      credential: sessionCookieCredential(request.headers.get('cookie') ?? ''),
    });
    await client.setWatchStatus(id, status);
  }

  // 303 so the browser follows with a GET and re-reads the list from the API.
  // The new status is then something the page was told, not something this
  // route assumed worked.
  //
  // Relative, and that is load-bearing rather than tidy. An absolute URL here
  // has to name a host, and the only host this process can name is the one it
  // thinks it is - `request.url` reports `localhost` whatever the browser
  // actually dialled. A browser that reached the dashboard by any other name,
  // `127.0.0.1` included, would follow that redirect onto a different origin,
  // and the session cookie is host-only: it would arrive signed out and be
  // bounced to the sign-in page by the guard. A relative `Location` leaves the
  // browser on the host it already chose, which is the only one known to work.
  return new Response(null, { status: 303, headers: { location: '/watches' } });
}
