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
import type { SlotTriggerPort, SlotTriggerRequest } from './slot-trigger.js';

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

function observed(report: CheckReport): Extract<CheckReport, { kind: 'observed' }> {
  if (report.kind !== 'observed') throw new Error(`expected an observed check, got ${report.kind}`);
  return report;
}

const CALENDAR =
  '<!doctype html><html><body><ul>' +
  '<li class="dmv-slot"><span class="dmv-when">Tue 8 Sep, 09:00</span></li>' +
  '<li class="dmv-slot"><span class="dmv-when">Thu 10 Sep, 14:00</span></li>' +
  '</ul></body></html>';

const TUESDAY = { id: 'Tue 8 Sep, 09:00', label: 'Tue 8 Sep, 09:00' };
const THURSDAY = { id: 'Thu 10 Sep, 14:00', label: 'Thu 10 Sep, 14:00' };
const LISTING = { kind: 'slots', slots: [TUESDAY, THURSDAY] } as const;

const SLOT_WATCH: WatchRecord = {
  ...WATCH,
  kind: 'slot',
  url: 'https://dmv.test/appointments',
  extractor: { version: 1, strategy: 'css', selector: '.dmv-slot .dmv-when', attribute: null, parse: 'slots' },
  condition: { site: 'fakedmv', applicant: { name: 'Ada Lovelace' }, auto_book: false },
};

/** A trigger port that remembers what it was asked and answers as told. */
function recordingTrigger(armed: boolean): SlotTriggerPort & { readonly requests: readonly SlotTriggerRequest[] } {
  const requests: SlotTriggerRequest[] = [];
  return {
    requests,
    arm(request) {
      requests.push(request);
      const observation: ObservationRecord = { id: 'observation-port', watchId: request.watch.id, checkedAt: NOW, ...request.observation };
      return Promise.resolve(
        armed ? { armed: true, taskId: 'task-1', observation } : { armed: false, reason: 'already paused', observation },
      );
    },
  };
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

describe('checkWatch on a slot watch', () => {
  it('hands the trigger the slot, the observation and the row patch in one call, and tells the person once it armed', async () => {
    const store = memoryStore(SLOT_WATCH);
    const trigger = recordingTrigger(true);
    const notifier = createRecordingNotifier();
    const ports: WatchCheckPorts = {
      store,
      ladder: servedLadder(CALENDAR),
      creator: refusingCreator(),
      notifier,
      slotTrigger: trigger,
      now: () => NOW,
    };

    const report = observed(await checkWatch(ports, store.row()));

    expect(report.comparison).toEqual({ triggered: true, reason: 'slot Tue 8 Sep, 09:00 appeared', slot: TUESDAY });
    expect(report.snipe).toMatchObject({ armed: true, taskId: 'task-1' });
    expect(report.observation).toMatchObject({ triggered: true, value: LISTING });
    expect(trigger.requests).toHaveLength(1);
    expect(trigger.requests[0]).toMatchObject({
      watch: { id: SLOT_WATCH.id },
      condition: { kind: 'slot', site: 'fakedmv', auto_book: false },
      slot: TUESDAY,
      observation: { triggered: true, value: LISTING, error: null },
      patch: { lastValue: LISTING, lastCheckedAt: NOW, consecutiveFailures: 0 },
    });
    // The port owns the write: nothing reached the store from the check itself.
    expect(store.observations).toEqual([]);
    expect(store.row()).toEqual(SLOT_WATCH);
    expect(notifier.calls).toHaveLength(1);
    expect(notifier.calls[0]).toMatchObject({ type: 'triggered', kind: 'slot', current: LISTING, reason: 'slot Tue 8 Sep, 09:00 appeared' });
  });

  it('tells nobody when the trigger found the watch already paused', async () => {
    const store = memoryStore(SLOT_WATCH);
    const trigger = recordingTrigger(false);
    const notifier = createRecordingNotifier();
    const ports: WatchCheckPorts = {
      store,
      ladder: servedLadder(CALENDAR),
      creator: refusingCreator(),
      notifier,
      slotTrigger: trigger,
      now: () => NOW,
    };

    const report = observed(await checkWatch(ports, store.row()));

    expect(report.snipe).toMatchObject({ armed: false, reason: 'already paused' });
    expect(trigger.requests).toHaveLength(1);
    expect(notifier.calls).toEqual([]);
  });

  it('fails, without telling anyone, on a worker that has no trigger to arm', async () => {
    const store = memoryStore(SLOT_WATCH);
    const notifier = createRecordingNotifier();
    const ports: WatchCheckPorts = {
      store,
      ladder: servedLadder(CALENDAR),
      creator: refusingCreator(),
      notifier,
      now: () => NOW,
    };

    const report = failed(await checkWatch(ports, store.row()));

    expect(report).toMatchObject({
      transient: false,
      reason: 'slot Tue 8 Sep, 09:00 appeared, but this worker has no booking trigger to arm',
    });
    expect(store.row()).toMatchObject({ status: 'active', lastValue: null, lastError: report.reason, consecutiveFailures: 1 });
    expect(store.observations.map((record) => record.error)).toEqual([report.reason]);
    expect(notifier.calls).toEqual([]);
  });

  it('records an empty calendar like any other quiet check, trigger or no trigger', async () => {
    const store = memoryStore(SLOT_WATCH);
    const notifier = createRecordingNotifier();
    const ports: WatchCheckPorts = {
      store,
      ladder: servedLadder('<html><body><ul><li class="dmv-empty">No appointments</li></ul></body></html>'),
      creator: refusingCreator(),
      notifier,
      now: () => NOW,
    };

    const report = observed(await checkWatch(ports, store.row()));

    expect(report.comparison).toEqual({ triggered: false, reason: 'no slots available' });
    expect(report.snipe).toBeUndefined();
    expect(store.row()).toMatchObject({ status: 'active', lastValue: { kind: 'slots', slots: [] }, consecutiveFailures: 0 });
    expect(notifier.calls).toEqual([]);
  });
});
