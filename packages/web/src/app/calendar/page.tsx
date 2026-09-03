import { headers } from 'next/headers';

import { createApiClient, sessionCookieCredential } from '../../api-client';
import { loadCalendarView, type CalendarRow } from '../../calendar/view-model';
import { loadWebConfig } from '../../config';

/**
 * The calendar section: what is coming, soonest first.
 *
 * Rendered per request, like every other page here - it is one account's rows,
 * read with that account's session, and a calendar that was built ahead of time
 * would be answering a question about a day that has since passed.
 */
export const dynamic = 'force-dynamic';

export default async function CalendarPage() {
  const cookie = (await headers()).get('cookie') ?? '';
  const client = createApiClient({
    baseUrl: loadWebConfig().apiBaseUrl,
    credential: sessionCookieCredential(cookie),
  });

  const view = await loadCalendarView(client);

  return (
    <section>
      <h1>Calendar</h1>
      {view.error === undefined ? null : (
        <p role="alert">Your calendar could not be loaded: {view.error}</p>
      )}
      {view.error === undefined && view.rows.length === 0 ? (
        <p>Nothing on the calendar yet. Renewals and deadlines will appear here by date.</p>
      ) : null}
      {view.rows.length === 0 ? null : (
        <ul>
          {view.rows.map((row) => (
            <li key={row.id}>
              <CalendarListItem row={row} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CalendarListItem({ row }: { readonly row: CalendarRow }) {
  return (
    <article>
      <h2>{row.name}</h2>
      {/* The badge names the kind in the reader's words rather than the
          schema's: a subscription renews and a deadline has to be acted on
          before it passes, and those are different things to be told. */}
      <p>{row.kind === 'deadline' ? 'Deadline' : 'Renewal'}</p>
      <dl>
        <dt>{row.dateLabel}</dt>
        <dd>{row.on ?? 'no date'}</dd>
        <dt>Amount</dt>
        {/* No currency symbol, because the schema stores integer cents and no
            currency. Printing a dollar sign would be this page inventing a fact
            about somebody's money. */}
        <dd>{row.amount ?? 'not recorded'}</dd>
        <dt>Status</dt>
        <dd>{row.status}</dd>
        {/* What an engine did about the entry, in the reader's words, with the
            engine's own sentence about it. Nothing at all when nothing has
            happened: an empty row here would be the page inventing news. */}
        {row.mark === undefined ? null : (
          <>
            <dt>{row.mark.label}</dt>
            <dd>{row.mark.note ?? 'no details recorded'}</dd>
          </>
        )}
      </dl>
    </article>
  );
}
