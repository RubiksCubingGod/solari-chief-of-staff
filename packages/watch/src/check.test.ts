import type { ExtractorCreator } from '@chief-of-staff/agent';
import {
  createRecordingNotifier,
  type FetchMeta,
  type NewObservation,
  type ObservationRecord,
  type WatchPatch,
  type WatchRecord,
  type WatchStore,
} from '@chief-of-staff/core';
import { describe, expect, it } from 'vitest';

import { checkWatch, type CheckReport, type WatchCheckPorts } from './check.js';
import type { FetchLadder } from './fetch/ladder.js';

/**
 * The composed check with every port faked in memory: what one tick writes
 * to the row, and what the next tick reads back from it. The integration
 * proof runs the same composition against Postgres and the fixtures; this
 * file is for the arithmetic between ticks, which needs no page and no
 * database.
 */

const NOW = new Date('2026-09-02T12:00:00.000Z');

const PAGE =
  '<!doctype html><html><body><main><h1>Widget</h1>' +
  '<p>A widget for widgeting, in stock and ready to ship today.</p>' +
  '</main></body></html>';

const WATCH: WatchRecord = {
  id: 'watch-1',
  userId: 'user-1',
  kind: 'price',
  url: 'https://shop.test/product/widget',
  extractor: {},
  condition: { drops_below: 15 },
  schedule: '*/15 * * * *',
  tierPolicy: 'auto',
  status: 'active',
  health: 'healthy',
  tierFloor: 'http',
  lastValue: null,
  lastCheckedAt: null,
  lastError: null,
  consecutiveFailures: 0,
};

interface MemoryStore extends WatchStore {
  row(): WatchRecord;
  readonly observations: readonly ObservationRecord[];
}

function memoryStore(seed: WatchRecord): MemoryStore {
  let row = seed;
  const observations: ObservationRecord[] = [];
  return {
    observations,
    row: () => row,
    loadWatch: (id) => Promise.resolve(id === row.id ? row : undefined),
    updateWatch(id, patch: WatchPatch) {
      if (id !== row.id) return Promise.reject(new Error(`no watch ${id}`));
      const defined = Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
      ) as Partial<WatchRecord>;
      row = { ...row, ...defined };
      return Promise.resolve();
    },
    recordObservation(watchId, observation: NewObservation) {
      const record: ObservationRecord = {
        id: `observation-${String(observations.length + 1)}`,
        watchId,
        checkedAt: NOW,
        ...observation,
      };
      observations.push(record);
      return Promise.resolve(record);
    },
    lastObservation: (watchId) =>
      Promise.resolve(observations.filter((record) => record.watchId === watchId).at(-1)),
  };
}

/** A ladder whose first tier always serves the same page. */
function servedLadder(html: string): FetchLadder {
  const meta: FetchMeta = {
    tier: 'http',
    url: WATCH.url,
    finalUrl: WATCH.url,
    status: 200,
    redirected: false,
    contentType: 'text/html; charset=utf-8',
    bytes: Buffer.byteLength(html),
    elapsedMs: 1,
    stealth: false,
  };
  return {
    fetchPage: () => Promise.resolve({ kind: 'fetched', tier: 'http', html, meta, attempts: [] }),
  };
}

/** A creator that declines every page, counting how often it was asked. */
function refusingCreator(): ExtractorCreator & { requests(): number } {
  let requests = 0;
  return {
    requests: () => requests,
    create() {
      requests += 1;
      return Promise.resolve({
        ok: false,
        failure: 'no-proposal',
        reason: 'the model described the page instead of choosing a selector',
      });
    },
  };
}

function failed(report: CheckReport): Extract<CheckReport, { kind: 'failed' }> {
  if (report.kind !== 'failed') throw new Error(`expected a failed check, got ${report.kind}`);
  return report;
}

describe('checkWatch between ticks', () => {
  it('parks a watch whose creator refuses under one reason that stays the same tick after tick', async () => {
    const store = memoryStore(WATCH);
    const creator = refusingCreator();
    const notifier = createRecordingNotifier();
    const ports: WatchCheckPorts = {
      store,
      ladder: servedLadder(PAGE),
      creator,
      notifier,
      now: () => NOW,
    };

    const first = failed(await checkWatch(ports, store.row()));
    expect(first).toMatchObject({
      transient: false,
      reason: 'no-proposal: the model described the page instead of choosing a selector',
    });
    expect(store.row()).toMatchObject({
      health: 'needs_extractor',
      lastError: first.reason,
      consecutiveFailures: 1,
    });

    const second = failed(await checkWatch(ports, store.row()));
    expect(second.reason).toBe(
      'no extractor: no-proposal: the model described the page instead of choosing a selector; reset the watch to try again',
    );

    const third = failed(await checkWatch(ports, store.row()));
    expect(third.reason).toBe(second.reason);
    expect(store.row()).toMatchObject({
      health: 'needs_extractor',
      lastError: second.reason,
      consecutiveFailures: 3,
    });
    expect(store.observations.map((record) => record.error)).toEqual([
      first.reason,
      second.reason,
      second.reason,
    ]);
    expect(creator.requests()).toBe(1);
    expect(notifier.calls).toEqual([]);
  });
});
