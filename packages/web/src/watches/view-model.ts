import type { WatchStatus } from '@chief-of-staff/core';

import { type ApiClient, type Observation, type Watch } from '../api-client';
import { describeRefusal } from '../api-refusal';

/**
 * Everything the watches page draws, worked out before any of it is drawn.
 *
 * The page is a server component, and a server component that throws renders
 * nothing at all - so the interesting question for this surface is not what it
 * shows when the API answers, it is what it shows when the API does not. That
 * decision lives here rather than in the JSX because it is the part with
 * branches worth testing, and because a `.tsx` file in this repository is not
 * under the coverage gate while a `.ts` file is.
 */

/** One watch as the page prints it: already formatted, already decided. */
export interface WatchRow {
  readonly id: string;
  readonly url: string;
  readonly status: WatchStatus;
  /**
   * The last reading, rendered. `undefined` for a watch nothing has checked
   * yet, which the page says in words rather than showing an empty cell.
   */
  readonly lastValue: string | undefined;
  readonly lastCheckedAt: string | undefined;
  /** The plottable readings, oldest first, exactly as the server ordered them. */
  readonly series: readonly number[];
  /**
   * Why this row has no sparkline, when the reason is a refusal rather than an
   * absence. One watch's history failing is not the page failing: the other
   * rows are still true and are still shown.
   */
  readonly seriesError: string | undefined;
}

export interface WatchesView {
  readonly rows: readonly WatchRow[];
  /**
   * Why there are no rows, when the reason is a refusal rather than an empty
   * account. The page shows this instead of the empty state, because "you have
   * no watches" is a lie to tell someone whose watches merely could not be
   * fetched.
   */
  readonly error: string | undefined;
}

export async function loadWatchesView(client: ApiClient): Promise<WatchesView> {
  let watches: readonly Watch[];
  try {
    watches = await client.listWatches();
  } catch (error: unknown) {
    return { rows: [], error: describeRefusal(error) };
  }

  // One request per watch, issued together rather than in turn. The API has no
  // route that returns several watches' histories at once, so the choice is
  // between N requests overlapped and N requests queued; a dashboard with a
  // dozen watches should not take a dozen round trips end to end.
  const rows = await Promise.all(watches.map((watch) => toRow(client, watch)));
  return { rows, error: undefined };
}

async function toRow(client: ApiClient, watch: Watch): Promise<WatchRow> {
  const summary = {
    id: watch.id,
    url: watch.url,
    status: watch.status,
    lastValue: renderReading(watch.lastValue),
    lastCheckedAt: watch.lastCheckedAt ?? undefined,
  };

  try {
    return { ...summary, series: plottable(await client.listObservations(watch.id)), seriesError: undefined };
  } catch (error: unknown) {
    // Scoped to this row on purpose. A history that could not be read says
    // nothing about the watch's own status, which was already read, or about
    // any other watch on the page.
    return { ...summary, series: [], seriesError: describeRefusal(error) };
  }
}

/**
 * The readings that have a height.
 *
 * A watch's value is whatever its extractor pulled off the page: a price is a
 * number, a slot is a string, a change is a document. Only the numbers are
 * points on a line, and giving the others a position would draw a chart that
 * means nothing - so they are left out of the plot and remain visible as the
 * watch's last reading, which is printed rather than plotted.
 */
function plottable(observations: readonly Observation[]): readonly number[] {
  return observations
    .map((observation) => observation.value)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

/** A reading as text, whatever the extractor stored. */
function renderReading(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

