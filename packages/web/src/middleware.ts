import { NextResponse, type NextRequest } from 'next/server';

import { REQUEST_LINK_PATH, readSessionReading } from './auth/session';

/**
 * The guard in front of the dashboard.
 *
 * Middleware rather than a check inside each page, because a check per page is
 * a check somebody forgets to add to the next one: the section added after this
 * task would be readable by anyone, and nothing would say so. Here the default
 * is "guarded", and the exceptions are the four patterns below - which is the
 * direction a security default should point.
 */

export const config = {
  // Node rather than the edge runtime: this guard asks the API over HTTP and
  // reads the API's origin out of the environment by name, and the edge build
  // only carries the variables it can see statically.
  runtime: 'nodejs',
  matcher: [
    /**
     * Everything except:
     *  - `_next/...`, which is the framework's own static output and carries
     *    nothing about anybody;
     *  - the request-link page itself, or an unauthenticated visitor would be
     *    redirected to the place they are already being redirected to;
     *  - `logout`, which has to work for exactly the person whose session no
     *    longer verifies - being sent to the login page instead would leave the
     *    stale cookie sitting in the browser;
     *  - `favicon.ico`, which a browser asks for before anyone has logged in.
     */
    '/((?!_next/|login|logout|favicon.ico).*)',
  ],
};

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const reading = await readSessionReading(request.headers.get('cookie') ?? undefined);

  if (reading.state === 'signed-in') return NextResponse.next();

  // An API that is not answering has not said this visitor is signed out, and
  // the guard has nothing to decide with. It lets the request past rather than
  // bouncing it, because the sign-in page it would bounce to needs that same
  // API to send a link - a redirect here is a loop that ends on a page which
  // cannot work either, and it tells a signed-in reader they have been signed
  // out when what actually happened is that a server is down.
  //
  // Letting it past discloses nothing. Nothing in this package reads the
  // database; every fact on every page arrives through the API that is not
  // answering, and each of those reads is authenticated by the API itself
  // rather than by this guard. A browser waved through during an outage
  // reaches pages that can only tell it the API did not answer - which is the
  // true thing to say - and is checked again on the next request.
  if (reading.state === 'unverifiable') return NextResponse.next();

  // A redirect rather than a 401 body: the visitor is a browser following a
  // link, and the useful thing to hand it is the page that can fix the problem.
  return NextResponse.redirect(new URL(REQUEST_LINK_PATH, request.url));
}
