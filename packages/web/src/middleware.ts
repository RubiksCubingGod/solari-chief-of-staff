import { NextResponse, type NextRequest } from 'next/server';

import { REQUEST_LINK_PATH, readSession } from './auth/session';

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
  const session = await readSession(request.headers.get('cookie') ?? undefined);
  if (session !== undefined) return NextResponse.next();

  // A redirect rather than a 401 body: the visitor is a browser following a
  // link, and the useful thing to hand it is the page that can fix the problem.
  return NextResponse.redirect(new URL(REQUEST_LINK_PATH, request.url));
}
