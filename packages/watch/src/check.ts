import { createHash } from 'node:crypto';

import { extractWatchValue, type ExtractionRoute, type ExtractorCreator } from '@chief-of-staff/agent';
import {
  compare,
  describeOutcome,
  errorObservation,
  isWatchValue,
  parseCondition,
  patchAfterObservation,
  successObservation,
  triggerDedupKey,
  type BlockSignal,
  type Comparison,
  type FetchTier,
  type NewObservation,
  type NotifierPort,
  type ObservationRecord,
  type WatchPatch,
  type WatchRecord,
  type WatchStore,
} from '@chief-of-staff/core';
import type { Database, JobRegistration } from '@chief-of-staff/db';

import { fetchWatchPage, type FetchLadder } from './fetch/ladder.js';
import { registerWatchScheduler, type WatchCheck } from './scheduler.js';
import { createDrizzleWatchStore } from './store.js';

/**
 * One check, composed: the ladder fetches, the extract step reads (and heals
 * or writes the extractor), the comparator judges, the store keeps the
 * observation, and the notifier hears about a crossing or a refusal. The
 * scheduler owns when a check runs and whether the row still wants one; this
 * module owns what a check is.
 *
 * Two orderings are deliberate. The notifier is told before the observation
 * is written, so a delivery that fails leaves the row as it was and the
 * retried tick sees the same crossing: the port is at-least-once, and its
 * dedup key is what makes the second delivery one trigger. And every failure
 * lands in the row and the observations table before this returns, so the
 * state a person reads is never behind the state the process knows.
 */
export interface WatchCheckPorts {
  readonly store: WatchStore;
  readonly ladder: FetchLadder;
  readonly creator: ExtractorCreator;
  readonly notifier: NotifierPort;
  readonly now?: () => Date;
}

export type CheckReport =
  | {
      readonly kind: 'observed';
      readonly observation: ObservationRecord;
      readonly comparison: Comparison;
      readonly route: ExtractionRoute;
    }
  | {
      readonly kind: 'failed';
      readonly observation: ObservationRecord;
      readonly reason: string;
      /**
       * Whether trying again soon could help. A site that did not answer is
       * transient; a page that is gone, a page that refuses this watch's
       * tiers, a condition nobody can read, and an extractor that could not
       * be written are not - the row says why, and only a change to the
       * world or to the watch changes the answer.
       */
      readonly transient: boolean;
    };

/**
 * The key a blocked event is deduplicated by: the watch, the tiers that were
 * tried, and what the refusal looked like. A worker that crashes after
 * telling the person and before writing the row tells them again with the
 * same key, and a consumer treats that as one event.
 */
export function blockedDedupKey(
  watchId: string,
  tiersTried: readonly FetchTier[],
  signal: BlockSignal,
): string {
  return createHash('sha256')
    .update(JSON.stringify([watchId, 'blocked', tiersTried, signal]))
    .digest('hex');
}

export async function checkWatch(ports: WatchCheckPorts, watch: WatchRecord): Promise<CheckReport> {
  const checkedAt = (ports.now ?? (() => new Date()))();

  // The condition is read before anything is fetched: a row whose condition
  // cannot be judged should not cost a page load to find that out.
  const condition = parseCondition(watch.kind, watch.condition);
  if (condition === undefined) {
    const reason = `the watch's condition is not one a check can read: ${JSON.stringify(watch.condition)}`;
    return fail(ports, watch, checkedAt, watch.tierFloor, reason, false);
  }

  const { outcome } = await fetchWatchPage(ports.ladder, ports.store, watch);
  if (outcome.kind === 'error') {
    return fail(ports, watch, checkedAt, outcome.tier, describeOutcome(outcome), true);
  }
  if (outcome.kind === 'gone') {
    return fail(ports, watch, checkedAt, outcome.tier, describeOutcome(outcome), false);
  }
  if (outcome.kind === 'blocked') {
    const reason = describeOutcome(outcome);
    // The transition is the news; a watch already known to be blocked is
    // not reported again on every tick.
    if (watch.health !== 'blocked') {
      await ports.notifier.notify({
        type: 'blocked',
        watchId: watch.id,
        userId: watch.userId,
        url: watch.url,
        occurredAt: checkedAt.toISOString(),
        dedupKey: blockedDedupKey(watch.id, outcome.tiersTried, outcome.signal),
        tiersTried: outcome.tiersTried,
        reason,
      });
    }
    const tier = outcome.tiersTried.at(-1) ?? watch.tierFloor;
    return fail(ports, watch, checkedAt, tier, reason, false, { health: 'blocked' });
  }

  const extraction = await extractWatchValue(ports, watch, outcome.html);
  if (!extraction.ok) {
    // The extract step has already written the health the failure earned.
    return fail(ports, watch, checkedAt, outcome.tier, extraction.reason, false);
  }

  // What the page last honestly said is on the row; a failed check in between
  // did not move it, so a trigger after an outage is about the page.
  const previous = isWatchValue(watch.lastValue) ? watch.lastValue : null;
  const comparison = compare(condition, previous, extraction.value);
  if (comparison.triggered) {
    await ports.notifier.notify({
      type: 'triggered',
      watchId: watch.id,
      userId: watch.userId,
      url: watch.url,
      occurredAt: checkedAt.toISOString(),
      dedupKey: triggerDedupKey(watch.id, condition, extraction.value),
      kind: watch.kind,
      condition,
      previous,
      current: extraction.value,
      reason: comparison.reason,
    });
  }
  const observation = await record(
    ports,
    watch,
    checkedAt,
    successObservation(outcome.tier, extraction.value, comparison.triggered),
  );
  return { kind: 'observed', observation, comparison, route: extraction.route };
}

async function fail(
  ports: WatchCheckPorts,
  watch: WatchRecord,
  checkedAt: Date,
  tier: FetchTier,
  reason: string,
  transient: boolean,
  extra: WatchPatch = {},
): Promise<CheckReport> {
  const observation = await record(ports, watch, checkedAt, errorObservation(tier, reason), extra);
  return { kind: 'failed', observation, reason, transient };
}

async function record(
  ports: WatchCheckPorts,
  watch: WatchRecord,
  checkedAt: Date,
  next: NewObservation,
  extra: WatchPatch = {},
): Promise<ObservationRecord> {
  const observation = await ports.store.recordObservation(watch.id, next);
  await ports.store.updateWatch(watch.id, { ...patchAfterObservation(watch, next, checkedAt), ...extra });
  return observation;
}

/**
 * The check as the scheduler runs it. A transient failure is thrown so the
 * harness retries the tick under its policy; everything else completed - the
 * row says what happened, and the next tick is the cron's.
 */
export function createWatchCheck(ports: WatchCheckPorts): WatchCheck {
  return async (watch) => {
    const report = await checkWatch(ports, watch);
    if (report.kind === 'failed' && report.transient) throw new Error(report.reason);
  };
}

export interface WatchEngineOptions {
  readonly db: Pick<Database, 'db'>;
  readonly ladder: FetchLadder;
  readonly creator: ExtractorCreator;
  readonly notifier: NotifierPort;
  readonly now?: () => Date;
}

/** The whole engine as one registration: the scheduler with the real check behind it. */
export function registerWatchEngine(options: WatchEngineOptions): JobRegistration {
  const store = createDrizzleWatchStore(options.db);
  const ports: WatchCheckPorts = {
    store,
    ladder: options.ladder,
    creator: options.creator,
    notifier: options.notifier,
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  return registerWatchScheduler({ db: options.db, store, check: createWatchCheck(ports) });
}
