import { headers } from 'next/headers';

import { createApiClient, sessionCookieCredential } from '../../api-client';
import { loadWebConfig } from '../../config';
import { Sparkline } from '../../watches/sparkline';
import { loadWatchesView, type WatchRow } from '../../watches/view-model';

/**
 * The watches section: every watch this account owns, what it last saw, where
 * it has been, and a switch to stop and start it.
 *
 * Rendered per request. There is no version of this page that can be built
 * ahead of time - it is one account's rows, read with that account's session,
 * and pausing a watch has to be visible on the very next render or the switch
 * is lying about what it did.
 */
export const dynamic = 'force-dynamic';

export default async function WatchesPage() {
  // The browser's own cookie, forwarded unread. The middleware has already
  // refused anyone who does not have one; this is how the API is told which
  // account the page is being drawn for.
  const cookie = (await headers()).get('cookie') ?? '';
  const client = createApiClient({
    baseUrl: loadWebConfig().apiBaseUrl,
    credential: sessionCookieCredential(cookie),
  });

  const view = await loadWatchesView(client);

  return (
    <section>
      <h1>Watches</h1>
      {view.error === undefined ? null : (
        // A refusal is content, not a blank screen: the reader is told the
        // rows could not be fetched rather than being shown a page that looks
        // like an account with nothing in it.
        <p role="alert">Your watches could not be loaded: {view.error}</p>
      )}
      {view.error === undefined && view.rows.length === 0 ? (
        <p>No watches yet. A watch you create will appear here with its history.</p>
      ) : null}
      {view.rows.length === 0 ? null : (
        <ul>
          {view.rows.map((row) => (
            <li key={row.id}>
              <WatchListItem row={row} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function WatchListItem({ row }: { readonly row: WatchRow }) {
  const paused = row.status === 'paused';

  return (
    <article>
      <h2>{row.url}</h2>
      <dl>
        <dt>Status</dt>
        <dd>{row.status}</dd>
        <dt>Last reading</dt>
        <dd>{row.lastValue ?? 'never checked'}</dd>
        <dt>Last checked</dt>
        <dd>{row.lastCheckedAt ?? 'never'}</dd>
      </dl>
      {row.seriesError === undefined ? (
        <Sparkline series={row.series} />
      ) : (
        // Scoped to the row it belongs to. One watch's history being refused
        // says nothing about the others, and blanking the page over it would
        // throw away every row that is fine.
        <p role="alert">History unavailable: {row.seriesError}</p>
      )}
      {/* A form rather than a link, for the same reason signing out is one: it
          changes something, and a GET that changes something is a URL a
          prefetcher will follow on the reader's behalf. */}
      <form method="post" action="/watches/pause">
        <input type="hidden" name="id" value={row.id} />
        <input type="hidden" name="status" value={paused ? 'active' : 'paused'} />
        <button type="submit">{paused ? `Resume ${row.url}` : `Pause ${row.url}`}</button>
      </form>
    </article>
  );
}
