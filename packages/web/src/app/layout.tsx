import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

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

export default function RootLayout({ children }: { readonly children: ReactNode }) {
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
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
