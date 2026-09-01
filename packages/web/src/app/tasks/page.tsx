import Link from 'next/link';
import { headers } from 'next/headers';

import { createApiClient, sessionCookieCredential } from '../../api-client';
import { loadWebConfig } from '../../config';
import { loadTasksView, type TaskRow } from '../../tasks/view-model';

/**
 * The task history: every run this account has asked for, newest first.
 *
 * A shell on purpose. s5 builds what a run looks like from the inside; what
 * this page owes it is an honest list and a link to the slot it will fill.
 */
export const dynamic = 'force-dynamic';

export default async function TasksPage() {
  const cookie = (await headers()).get('cookie') ?? '';
  const client = createApiClient({
    baseUrl: loadWebConfig().apiBaseUrl,
    credential: sessionCookieCredential(cookie),
  });

  const view = await loadTasksView(client);

  return (
    <section>
      <h1>Tasks</h1>
      {view.error === undefined ? null : (
        <p role="alert">Your tasks could not be loaded: {view.error}</p>
      )}
      {view.error === undefined && view.rows.length === 0 ? (
        <p>No tasks yet. A run you start will appear here with what became of it.</p>
      ) : null}
      {view.rows.length === 0 ? null : (
        <ul>
          {view.rows.map((row) => (
            <li key={row.id}>
              <TaskListItem row={row} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TaskListItem({ row }: { readonly row: TaskRow }) {
  return (
    <article>
      {/* The heading is the link, so the row is reachable by the name it is
          announced under rather than by a separate "view" affordance. */}
      <h2>
        <Link href={row.href}>{row.kind}</Link>
      </h2>
      <dl>
        <dt>Status</dt>
        <dd>{row.status}</dd>
        <dt>Started</dt>
        <dd>{row.createdAt}</dd>
      </dl>
    </article>
  );
}
