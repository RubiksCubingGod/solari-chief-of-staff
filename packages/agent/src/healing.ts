import { createHash } from 'node:crypto';

import {
  describeReplayFailure,
  parseExtractorSpec,
  replayExtractor,
  type DegradedEvent,
  type NotifierPort,
  type WatchRecord,
  type WatchStore,
  type WatchValue,
} from '@chief-of-staff/core';

import {
  describeCreationFailure,
  provisionExtractor,
  regionHint,
  type ExtractorCreator,
} from './extractor.js';

/**
 * The extract step of a check, with its healing budget.
 *
 * Between creation and breakage a check costs no model call: the stored
 * extractor is replayed and that is all. When replay fails, the failure is a
 * breakage incident and it buys exactly one re-creation against the page as
 * it is now. A proposal that reads the page is stored and the watch goes on;
 * one that does not leaves the watch `degraded`, tells the person once, and
 * from then on every check records the failure without asking the model
 * again. The incident ends when a value is read again - the page came back,
 * or a person reset the watch - and the next breakage buys the next call.
 *
 * A watch with no extractor at all is the first check's problem: one creation
 * call, and if that fails the watch waits in `needs_extractor` for a reset
 * rather than spending on every tick.
 */

export const EXTRACTION_ROUTES = ['replayed', 'created', 'healed'] as const;
export type ExtractionRoute = (typeof EXTRACTION_ROUTES)[number];

export type ExtractionSubject = Pick<
  WatchRecord,
  'id' | 'userId' | 'url' | 'kind' | 'condition' | 'extractor' | 'health' | 'lastError'
>;

export interface ExtractionPorts {
  readonly store: Pick<WatchStore, 'updateWatch'>;
  readonly creator: ExtractorCreator;
  readonly notifier: NotifierPort;
  readonly now?: () => Date;
}

export type Extraction =
  | { readonly ok: true; readonly route: ExtractionRoute; readonly value: WatchValue }
  | {
      readonly ok: false;
      /** What the watch's health is now. */
      readonly health: 'needs_extractor' | 'degraded';
      readonly reason: string;
    };

/**
 * A value out of the page, by whichever route the watch's state allows. The
 * watch is patched on the way: a spec that was written, a health that
 * changed, a reason a person should see.
 */
export async function extractWatchValue(
  ports: ExtractionPorts,
  watch: ExtractionSubject,
  html: string,
): Promise<Extraction> {
  const spec = parseExtractorSpec(watch.extractor);
  if (spec === undefined) return createFirst(ports, watch, html);

  const replay = replayExtractor(spec, html);
  if (replay.ok) {
    // A value in hand is the whole of what "healthy" means for extraction,
    // and it settles a blocked verdict too: the page was fetched to get here.
    if (watch.health !== 'healthy') {
      await ports.store.updateWatch(watch.id, { health: 'healthy', lastError: null });
    }
    return { ok: true, route: 'replayed', value: replay.value };
  }

  const broke = describeReplayFailure(replay);
  if (watch.health === 'degraded') {
    return {
      ok: false,
      health: 'degraded',
      reason: `${broke}; the watch is degraded and gets no new extractor until it is reset`,
    };
  }
  return heal(ports, watch, html, broke);
}

async function createFirst(ports: ExtractionPorts, watch: ExtractionSubject, html: string): Promise<Extraction> {
  if (watch.health === 'needs_extractor') {
    return { ok: false, health: 'needs_extractor', reason: parkedReason(watch.lastError) };
  }
  const creation = await provisionExtractor(ports.creator, ports.store, watch, html);
  return creation.ok
    ? { ok: true, route: 'created', value: creation.value }
    : { ok: false, health: 'needs_extractor', reason: describeCreationFailure(creation) };
}

const PARKED_PREFIX = 'no extractor: ';
const PARKED_SUFFIX = '; reset the watch to try again';

/**
 * The reason a parked watch reports every tick. The check writes it back to
 * the row as `last_error`, and the next tick reads it from there, so a reason
 * that is already in this frame is handed back as it is rather than wrapped
 * in another one; otherwise the row would grow by a frame per tick.
 */
function parkedReason(lastError: string | null): string {
  if (lastError !== null && lastError.startsWith(PARKED_PREFIX) && lastError.endsWith(PARKED_SUFFIX)) {
    return lastError;
  }
  return `${PARKED_PREFIX}${lastError ?? 'the last attempt to write one failed'}${PARKED_SUFFIX}`;
}

async function heal(
  ports: ExtractionPorts,
  watch: ExtractionSubject,
  html: string,
  broke: string,
): Promise<Extraction> {
  const creation = await ports.creator.create({
    url: watch.url,
    kind: watch.kind,
    html,
    hint: regionHint(watch),
  });
  if (creation.ok) {
    await ports.store.updateWatch(watch.id, { extractor: creation.spec, health: 'healthy', lastError: null });
    return { ok: true, route: 'healed', value: creation.value };
  }

  const reason = `the extractor broke (${broke}) and a new one could not be written: ${describeCreationFailure(creation)}`;
  // State first, then the message: a delivery that fails fails the job, and
  // the retry finds a degraded watch to report on rather than a healthy one
  // to spend on again.
  await ports.store.updateWatch(watch.id, { health: 'degraded', lastError: reason });
  const event: DegradedEvent = {
    type: 'degraded',
    watchId: watch.id,
    userId: watch.userId,
    url: watch.url,
    occurredAt: (ports.now ?? (() => new Date()))().toISOString(),
    dedupKey: degradedDedupKey(watch.id, reason),
    reason,
  };
  await ports.notifier.notify(event);
  return { ok: false, health: 'degraded', reason };
}

/**
 * The identity of a degraded event: the watch and the reason. A job retried
 * after a crash reaches the same reason from the same page and says the same
 * thing; a later incident, after a reset, reads differently.
 */
export function degradedDedupKey(watchId: string, reason: string): string {
  return createHash('sha256').update(JSON.stringify([watchId, 'degraded', reason])).digest('hex');
}
