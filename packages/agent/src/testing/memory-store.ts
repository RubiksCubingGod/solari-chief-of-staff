import type {
  NewObservation,
  ObservationRecord,
  WatchPatch,
  WatchRecord,
  WatchStore,
} from '@chief-of-staff/core';

/**
 * The store port in memory, for proofs of what a check does to a watch
 * without a database in the way. It honours the port's one rule about
 * patches - `undefined` is "not mentioned", `null` is a value - and keeps
 * every patch it was handed, so a proof can say "and nothing was written".
 *
 * Source-only, like the scripted model beside it.
 */

export interface MemoryWatchStore extends WatchStore {
  /** Every patch applied, oldest first. */
  readonly patches: readonly { readonly id: string; readonly patch: WatchPatch }[];
  readonly observations: readonly ObservationRecord[];
  /** The row as it stands; throws for an id it does not hold. */
  row(id: string): WatchRecord;
}

export function createMemoryWatchStore(seed: readonly WatchRecord[] = []): MemoryWatchStore {
  const rows = new Map<string, WatchRecord>(seed.map((watch) => [watch.id, watch]));
  const patches: { id: string; patch: WatchPatch }[] = [];
  const observations: ObservationRecord[] = [];

  return {
    patches,
    observations,
    row(id) {
      const row = rows.get(id);
      if (row === undefined) throw new Error(`no watch ${id} in the memory store`);
      return row;
    },
    loadWatch(id) {
      return Promise.resolve(rows.get(id));
    },
    updateWatch(id, patch) {
      const row = rows.get(id);
      if (row === undefined) return Promise.reject(new Error(`no watch ${id} to update`));
      patches.push({ id, patch });
      rows.set(id, {
        ...row,
        ...(patch.extractor === undefined ? {} : { extractor: patch.extractor }),
        ...(patch.health === undefined ? {} : { health: patch.health }),
        ...(patch.tierFloor === undefined ? {} : { tierFloor: patch.tierFloor }),
        ...(patch.lastValue === undefined ? {} : { lastValue: patch.lastValue }),
        ...(patch.lastCheckedAt === undefined ? {} : { lastCheckedAt: patch.lastCheckedAt }),
        ...(patch.lastError === undefined ? {} : { lastError: patch.lastError }),
        ...(patch.consecutiveFailures === undefined ? {} : { consecutiveFailures: patch.consecutiveFailures }),
      });
      return Promise.resolve();
    },
    recordObservation(watchId, observation: NewObservation) {
      const record: ObservationRecord = {
        id: `observation-${String(observations.length + 1)}`,
        watchId,
        checkedAt: new Date(),
        tierUsed: observation.tierUsed,
        value: observation.value,
        triggered: observation.triggered,
        error: observation.error,
      };
      observations.push(record);
      return Promise.resolve(record);
    },
    lastObservation(watchId) {
      return Promise.resolve(observations.filter((record) => record.watchId === watchId).at(-1));
    },
  };
}

/** A price watch on a fixture shop's widget, healthy and never checked, unless told otherwise. */
export function sampleWatch(overrides: Partial<WatchRecord> = {}): WatchRecord {
  return {
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
    ...overrides,
  };
}
