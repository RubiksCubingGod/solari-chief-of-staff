import {
  isWatchValue,
  type NewObservation,
  type ObservationRecord,
  type WatchPatch,
  type WatchRecord,
  type WatchStore,
} from '@chief-of-staff/core';
import { observations, watches, type Database } from '@chief-of-staff/db';
import { desc, eq } from 'drizzle-orm';

/**
 * The store port bound to the schema.
 *
 * Deliberately thin: it moves rows in and out and interprets nothing. The one
 * judgment it makes is on the way out of `observations.value`, where a stored
 * value that no longer parses as one is read as none rather than trusted, so a
 * comparison never runs against a shape the comparator was not written for.
 */

type WatchRow = typeof watches.$inferSelect;
type ObservationRow = typeof observations.$inferSelect;
type WatchColumns = Partial<typeof watches.$inferInsert>;

export function createDrizzleWatchStore(database: Pick<Database, 'db'>): WatchStore {
  const { db } = database;

  return {
    async loadWatch(id) {
      const [row] = await db.select().from(watches).where(eq(watches.id, id)).limit(1);
      return row === undefined ? undefined : toWatchRecord(row);
    },

    async updateWatch(id, patch) {
      const columns = columnsOf(patch);
      // An empty SET is a SQL error, and an empty patch is a check that had
      // nothing to say - which is not an error.
      if (Object.keys(columns).length === 0) return;
      await db.update(watches).set(columns).where(eq(watches.id, id));
    },

    async recordObservation(watchId, observation) {
      const [row] = await db.insert(observations).values(valuesOf(watchId, observation)).returning();
      if (row === undefined) throw new Error(`the observation for watch ${watchId} was not returned`);
      return toObservationRecord(row);
    },

    async lastObservation(watchId) {
      const [row] = await db
        .select()
        .from(observations)
        .where(eq(observations.watchId, watchId))
        .orderBy(desc(observations.checkedAt))
        .limit(1);
      return row === undefined ? undefined : toObservationRecord(row);
    },
  };
}

export function toWatchRecord(row: WatchRow): WatchRecord {
  return {
    id: row.id,
    userId: row.userId,
    kind: row.kind,
    url: row.url,
    extractor: row.extractor,
    condition: row.condition,
    schedule: row.schedule,
    tierPolicy: row.tierPolicy,
    status: row.status,
    health: row.health,
    tierFloor: row.tierFloor,
    lastValue: row.lastValue,
    lastCheckedAt: row.lastCheckedAt,
    lastError: row.lastError,
    consecutiveFailures: row.consecutiveFailures,
  };
}

export function toObservationRecord(row: ObservationRow): ObservationRecord {
  return {
    id: row.id,
    watchId: row.watchId,
    checkedAt: row.checkedAt,
    tierUsed: row.tierUsed,
    value: isWatchValue(row.value) ? row.value : null,
    triggered: row.triggered,
    error: row.error,
  };
}

export function valuesOf(watchId: string, observation: NewObservation): typeof observations.$inferInsert {
  return {
    watchId,
    tierUsed: observation.tierUsed,
    value: observation.value,
    triggered: observation.triggered,
    error: observation.error,
  };
}

/** Only the columns the patch names. `undefined` is "not mentioned"; `null` is a value. */
export function columnsOf(patch: WatchPatch): WatchColumns {
  const columns: WatchColumns = {};
  if (patch.extractor !== undefined) columns.extractor = patch.extractor;
  if (patch.health !== undefined) columns.health = patch.health;
  if (patch.tierFloor !== undefined) columns.tierFloor = patch.tierFloor;
  if (patch.lastValue !== undefined) columns.lastValue = patch.lastValue;
  if (patch.lastCheckedAt !== undefined) columns.lastCheckedAt = patch.lastCheckedAt;
  if (patch.lastError !== undefined) columns.lastError = patch.lastError;
  if (patch.consecutiveFailures !== undefined) columns.consecutiveFailures = patch.consecutiveFailures;
  return columns;
}
