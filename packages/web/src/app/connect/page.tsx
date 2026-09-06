import { headers } from 'next/headers';

import { describeRefusal } from '../../api-refusal';
import { connectClientForCookie, type SiteConnection } from '../../connect/client';
import { CONNECT_OUTCOME_PARAMETER, describeConnectOutcome } from '../../connect/connect-outcome';

/**
 * The sites this account is connected to, and the form that connects another.
 *
 * A connection is a browser profile the vendor holds with the person's login
 * in it; this page never sees a credential and has no field for one. What it
 * shows is which sites a task can sign in to, which have gone stale, and the
 * one control that fixes either: connect, which starts an attempt and hands
 * the person to the vendor console to log in themselves.
 *
 * Rendered per request, as the watches page is: one account's rows, read with
 * that account's session, and a confirm has to show on the very next render.
 */
export const dynamic = 'force-dynamic';

export default async function ConnectPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const outcome = describeConnectOutcome((await searchParams)[CONNECT_OUTCOME_PARAMETER]);
  const client = connectClientForCookie((await headers()).get('cookie') ?? '');

  let rows: readonly SiteConnection[] = [];
  let error: string | undefined;
  try {
    rows = await client.listConnections();
  } catch (failure) {
    error = describeRefusal(failure);
  }

  return (
    <section>
      <h1>Sites</h1>
      {outcome === undefined ? null : <p role="alert">{outcome}</p>}
      {error === undefined ? null : <p role="alert">Your connected sites could not be loaded: {error}</p>}
      <p>
        Connecting a site lets tasks act there as you. You sign in yourself, in the browser
        console, and this dashboard keeps only the profile that holds the session. It never asks
        for a password.
      </p>
      <form method="post" action="/connect/start">
        <label>
          Site to connect
          <input type="text" name="siteDomain" placeholder="gym.example.com" required />
        </label>
        <button type="submit">Connect</button>
      </form>
      {error === undefined && rows.length === 0 ? (
        <p>No sites connected yet. A site you connect will appear here with its status.</p>
      ) : null}
      {rows.length === 0 ? null : (
        <ul>
          {rows.map((row) => (
            <li key={row.id}>
              <ConnectionListItem row={row} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ConnectionListItem({ row }: { readonly row: SiteConnection }) {
  const expired = row.status === 'expired';

  return (
    <article>
      <h2>{row.siteDomain}</h2>
      <dl>
        <dt>Status</dt>
        <dd>{expired ? 'expired: the site stopped honouring the saved session' : 'connected'}</dd>
        <dt>Last used</dt>
        <dd>{row.lastUsedAt ?? 'never'}</dd>
      </dl>
      {/* Reconnecting is a fresh attempt on the same domain: the API swaps the
          profile the row names once the person confirms the new one. */}
      <form method="post" action="/connect/start">
        <input type="hidden" name="siteDomain" value={row.siteDomain} />
        <button type="submit">{expired ? `Reconnect ${row.siteDomain}` : `Sign in again to ${row.siteDomain}`}</button>
      </form>
    </article>
  );
}
