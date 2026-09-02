import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { createApiClient, sessionCookieCredential } from '../../../api-client';
import { loadWebConfig } from '../../../config';
import { loadTaskDetail, type TimelineEntry } from '../../../tasks/detail-view-model';
import { ReplayPlayer } from '../../../tasks/replay-player';

/**
 * One task from the inside: what it is, everything that happened to it, and -
 * where the run was recorded - what it looked like while it happened.
 *
 * This is the trust surface the action engine answers to. A run that asked a
 * question, was refused by a guardrail, or failed on the site says so here, in
 * the order it happened, and a recording plays beside the words. Where there
 * is no recording the page says that too, rather than leaving a gap a reader
 * would fill with a guess.
 */
export const dynamic = 'force-dynamic';

interface TaskDetailPageProps {
  readonly params: Promise<{ readonly id: string }>;
}

export default async function TaskDetailPage({ params }: TaskDetailPageProps) {
  const { id } = await params;
  const cookie = (await headers()).get('cookie') ?? '';
  const client = createApiClient({
    baseUrl: loadWebConfig().apiBaseUrl,
    credential: sessionCookieCredential(cookie),
  });

  const outcome = await loadTaskDetail(client, id);
  // A stranger's task and a task that never existed are the same page: the
  // API answers both with 404, and this page does not know which it got.
  if (outcome.kind === 'missing') notFound();
  if (outcome.kind === 'failed') {
    return (
      <section>
        <h1>Task</h1>
        <p role="alert">This task could not be loaded: {outcome.error}</p>
      </section>
    );
  }

  const view = outcome.view;
  return (
    <section>
      <p>
        <Link href="/tasks">All tasks</Link>
      </p>
      <h1>{view.kind}</h1>
      <dl>
        <dt>Status</dt>
        <dd>{view.status}</dd>
        <dt>Mode</dt>
        <dd>{view.mode}</dd>
        <dt>Started</dt>
        <dd>{view.createdAt}</dd>
        <dt>Finished</dt>
        <dd>{view.finishedAt ?? 'not yet'}</dd>
      </dl>
      {view.pendingQuestion === undefined ? null : (
        <p role="status">Waiting for your answer: {view.pendingQuestion.question}</p>
      )}

      <h2>Replay</h2>
      {view.recordingHref === undefined ? (
        <p>No recording available for this run.</p>
      ) : (
        <ReplayPlayer src={view.recordingHref} />
      )}

      <h2>Timeline</h2>
      {view.timeline.length === 0 ? (
        <p>Nothing has been written about this run yet.</p>
      ) : (
        <ol aria-label="Timeline">
          {view.timeline.map((entry) => (
            <li key={entry.seq}>
              <TimelineItem entry={entry} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function TimelineItem({ entry }: { readonly entry: TimelineEntry }) {
  return (
    <>
      <time dateTime={entry.ts}>{entry.ts}</time> <span>{entry.headline}</span>
      {entry.detail === undefined ? null : <small> {entry.detail}</small>}
    </>
  );
}
