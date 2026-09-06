import { REQUEST_LINK_PATH } from '../../auth/session';
import { loadWebConfig } from '../../config';

/**
 * Ends the session and sends the visitor back to the sign-in page.
 *
 * The dashboard cannot clear the cookie by itself in any meaningful sense - it
 * did not set it and does not know what it is worth - so it asks the API to end
 * the session and passes the API's own `Set-Cookie` back to the browser
 * verbatim. The cookie carries no `Domain` in the loopback and single-host
 * deployments this supports, which makes it host-only: the header that clears
 * it from the API's origin is the same header that clears it from this one.
 */
export async function POST(request: Request): Promise<Response> {
  const cookieHeader = request.headers.get('cookie');
  const response = await fetch(`${loadWebConfig().apiBaseUrl}/auth/logout`, {
    method: 'POST',
    // Manual, because the interesting part of the API's answer is the header it
    // sets, and following its redirect would take us to the API's own idea of
    // where the dashboard is instead of to this app's.
    redirect: 'manual',
    headers: cookieHeader === null ? {} : { cookie: cookieHeader },
  });

  // Relative, because `request.url` reports the host this process thinks it is
  // rather than the one the browser dialled - `localhost` even for a browser on
  // `127.0.0.1`. An absolute `Location` built from it moves the reader to
  // another origin on the way out, which at best signs them back in somewhere
  // else and at worst names a host nothing outside the server can reach.
  const headers = new Headers({ location: REQUEST_LINK_PATH });
  const cleared = response.headers.get('set-cookie');
  if (cleared !== null) headers.append('set-cookie', cleared);
  return new Response(null, { status: 303, headers });
}
