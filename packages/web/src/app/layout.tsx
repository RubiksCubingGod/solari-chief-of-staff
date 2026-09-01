import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { readSession } from '../auth/session';

/**
 * The shell every page lands in. The three sections below are built by the
 * tasks after this one; the navigation names them from the start so a page is
 * something that lands *in* the dashboard rather than something that has to
 * redraw it.
 */
const SECTIONS = [
  { href: '/', label: 'Overview' },
  { href: '/watches', label: 'Watches' },
  { href: '/calendar', label: 'Calendar' },
  { href: '/tasks', label: 'Tasks' },
] as const;

export const metadata: Metadata = {
  title: 'Chief of Staff',
  description: 'Watches, the calendar they feed, and the tasks that act on both.',
};

export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  // Asked here as well as in the middleware, and for a different reason: the
  // guard decides whether a page may be drawn, this decides what the shell says
  // about who is drawing it. The sign-in page shares this layout and has no
  // session, so both shapes have to render.
  const session = await readSession((await headers()).get('cookie') ?? undefined);

  return (
    <html lang="en">
      <body>
        <header>
          <p>Chief of Staff</p>
          <nav aria-label="Dashboard sections">
            <ul>
              {SECTIONS.map((section) => (
                <li key={section.href}>
                  <Link href={section.href}>{section.label}</Link>
                </li>
              ))}
            </ul>
          </nav>
          {session === undefined ? null : (
            <div>
              <p>Signed in as {session.email ?? 'an account with no address on file'}</p>
              {/* A form rather than a link: signing out changes something, and
                  a GET that changes something is a link a page prefetcher can
                  follow on the reader's behalf. */}
              <form method="post" action="/logout">
                <button type="submit">Sign out</button>
              </form>
            </div>
          )}
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
