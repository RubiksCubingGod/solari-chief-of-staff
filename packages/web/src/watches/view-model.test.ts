import { describe, expect, it } from 'vitest';

import {
  ApiError,
  ApiUnreachableError,
  type Observation,
  type Watch,
} from '../api-client';
import { stubClient } from '../testing/stub-client';
import { loadWatchesView } from './view-model';

/**
 * What the page does when the API does not cooperate, proven here rather than
 * in the browser.
 *
 * The end-to-end proof drives a real API, and a real API that is working cannot
 * be made to refuse on cue without breaking the run it is in the middle of.
 * These are the branches that live on the other side of that: an outage, a
 * refusal, and one watch's history failing while the rest of the page is fine.
 */

function watch(overrides: Partial<Watch> & { readonly id: string }): Watch {
  return {
    userId: 'user-1',
    kind: 'price',
    url: `https://example.test/${overrides.id}`,
    extractor: { kind: 'css', selector: '#price' },
    condition: { kind: 'below', value: 100 },
    schedule: '0 * * * *',
    tierPolicy: 'auto',
    status: 'active',
    lastValue: null,
    lastCheckedAt: null,
    consecutiveFailures: 0,
    ...overrides,
  };
}

function observation(value: unknown, index = 0): Observation {
  return {
    id: `observation-${String(index)}`,
    watchId: 'watch-1',
    checkedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    tierUsed: 'http',
    value,
    triggered: false,
    error: null,
  };
}

const refused = new ApiError(500, 'internal_error', 'Something went wrong.', []);

describe('loadWatchesView', () => {
  it('carries each watch through with its rendered reading and its series', async () => {
    const view = await loadWatchesView(
      stubClient({
        listWatches: () =>
          Promise.resolve([
            watch({ id: 'watch-1', lastValue: 129, lastCheckedAt: '2026-01-01T00:02:00.000Z' }),
          ]),
        listObservations: () =>
          Promise.resolve([observation(149, 0), observation(139, 1), observation(129, 2)]),
      }),
    );

    expect(view.error).toBeUndefined();
    expect(view.rows).toEqual([
      {
        id: 'watch-1',
        url: 'https://example.test/watch-1',
        status: 'active',
        lastValue: '129',
        lastCheckedAt: '2026-01-01T00:02:00.000Z',
        series: [149, 139, 129],
        seriesError: undefined,
      },
    ]);
  });

  it('leaves a never-checked watch with nothing to plot and nothing to report', async () => {
    const view = await loadWatchesView(
      stubClient({
        listWatches: () => Promise.resolve([watch({ id: 'watch-1' })]),
        listObservations: () => Promise.resolve([]),
      }),
    );

    // Not an error: a watch that has never run is an ordinary watch, and the
    // page says so in words rather than showing an empty chart.
    expect(view.rows[0]?.lastValue).toBeUndefined();
    expect(view.rows[0]?.lastCheckedAt).toBeUndefined();
    expect(view.rows[0]?.series).toEqual([]);
    expect(view.rows[0]?.seriesError).toBeUndefined();
  });

  it('renders a reading that is not a number rather than dropping it', async () => {
    // An extractor stores whatever the page gave it, and the schema does not
    // narrow that to a price. Each of these is a reading somebody's watch
    // actually produces, and none of them may come out blank.
    const readings: readonly (readonly [unknown, string])[] = [
      ['in stock', 'in stock'],
      [true, 'true'],
      [{ price: 129 }, '{"price":129}'],
    ];

    for (const [stored, shown] of readings) {
      const view = await loadWatchesView(
        stubClient({
          listWatches: () => Promise.resolve([watch({ id: 'watch-1', lastValue: stored })]),
          listObservations: () => Promise.resolve([]),
        }),
      );

      expect(view.rows[0]?.lastValue, `stored ${JSON.stringify(stored)}`).toBe(shown);
    }
  });

  it('plots only the readings that are numbers, because only those have a height', async () => {
    const view = await loadWatchesView(
      stubClient({
        listWatches: () => Promise.resolve([watch({ id: 'watch-1' })]),
        // A `change` watch stores a document, a `slot` watch stores a string.
        // Neither is a point on a line, and inventing one for them would draw a
        // chart that means nothing.
        listObservations: () =>
          Promise.resolve([
            observation(10, 0),
            observation('in stock', 1),
            observation(null, 2),
            observation(12, 3),
          ]),
      }),
    );

    expect(view.rows[0]?.series).toEqual([10, 12]);
  });

  it('reports a refused list as an error instead of as an empty account', async () => {
    const view = await loadWatchesView(stubClient({ listWatches: () => Promise.reject(refused) }));

    expect(view.rows).toEqual([]);
    // The distinction the whole branch exists for: "you have no watches" would
    // be a lie told to someone whose watches merely could not be fetched.
    expect(view.error).toContain('Something went wrong.');
  });

  it('says the API did not answer when it did not answer', async () => {
    const view = await loadWatchesView(
      stubClient({
        listWatches: () =>
          Promise.reject(new ApiUnreachableError('https://api.example.com', new Error('ECONNREFUSED'))),
      }),
    );

    expect(view.rows).toEqual([]);
    expect(view.error).toContain('did not answer');
  });

  it('keeps every other row when one watch’s history is refused', async () => {
    const view = await loadWatchesView(
      stubClient({
        listWatches: () =>
          Promise.resolve([watch({ id: 'watch-1' }), watch({ id: 'watch-2', lastValue: 5 })]),
        listObservations: (watchId) =>
          watchId === 'watch-1'
            ? Promise.reject(refused)
            : Promise.resolve([observation(4, 0), observation(5, 1)]),
      }),
    );

    expect(view.error).toBeUndefined();
    expect(view.rows[0]?.seriesError).toContain('Something went wrong.');
    expect(view.rows[0]?.series).toEqual([]);
    // The point of scoping it: the second watch is still completely true.
    expect(view.rows[1]?.seriesError).toBeUndefined();
    expect(view.rows[1]?.series).toEqual([4, 5]);
    expect(view.rows[1]?.lastValue).toBe('5');
  });

  it('lets an error that is not the API talking reach the framework', async () => {
    const bug = new TypeError('cannot read properties of undefined');

    // A page state is for things the API said. A defect in this process is not
    // one of those, and swallowing it into a tidy error banner would hide the
    // stack that says where it is.
    await expect(
      loadWatchesView(stubClient({ listWatches: () => Promise.reject(bug) })),
    ).rejects.toThrow(bug);
  });
});
