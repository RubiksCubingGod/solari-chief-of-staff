import { createHash } from 'node:crypto';

import type { FetchTier, WatchKind } from '../index.js';
import type { WatchCondition } from './condition.js';
import type { SlotListing, WatchValue } from './value.js';

/**
 * The notifier port: the seam the watch engine ends at.
 *
 * The engine tells a person four things - a watch triggered, a watch is
 * blocked at every tier, a watch has degraded past its healing budget, and
 * what became of a slot watch's booking - and it tells them through this
 * interface. The recording double below is what every pipeline proof asserts
 * against; calendar-wiring (s7) implements the port over the bot's outbound
 * door.
 */

export const WATCH_EVENT_TYPES = ['triggered', 'blocked', 'degraded', 'booking'] as const;
export type WatchEventType = (typeof WATCH_EVENT_TYPES)[number];

interface WatchEventBase {
  readonly watchId: string;
  readonly userId: string;
  readonly url: string;
  /** ISO instant. */
  readonly occurredAt: string;
  /**
   * The identity of the event: two emissions with the same key are one event
   * delivered twice. Emission is at-least-once, so consumers dedup on this.
   */
  readonly dedupKey: string;
}

export interface TriggeredEvent extends WatchEventBase {
  readonly type: 'triggered';
  readonly kind: WatchKind;
  readonly condition: WatchCondition;
  readonly previous: WatchValue | null;
  readonly current: WatchValue;
  readonly reason: string;
}

export interface BlockedEvent extends WatchEventBase {
  readonly type: 'blocked';
  readonly tiersTried: readonly FetchTier[];
  readonly reason: string;
}

export interface DegradedEvent extends WatchEventBase {
  readonly type: 'degraded';
  readonly reason: string;
}

/** What became of the watch once its booking task ended. */
export const BOOKING_OUTCOMES = ['booked', 'rearmed', 'paused'] as const;
export type BookingOutcome = (typeof BOOKING_OUTCOMES)[number];

/**
 * The outcome of a slot watch's booking: the one message a snipe owes the
 * person after the sighting. `booked` carries the site's reference and the
 * watch stays paused, its job done; `rearmed` means the slot went or the
 * person passed on it and the watch is looking again; `paused` means the
 * booking failed for a reason a person has to look at, and the watch waits.
 */
export interface BookingEvent extends WatchEventBase {
  readonly type: 'booking';
  readonly taskId: string;
  readonly slot: SlotListing;
  readonly outcome: BookingOutcome;
  /** The site's confirmation, when the outcome is `booked`. */
  readonly reference: string | null;
  readonly reason: string;
}

export type WatchEvent = TriggeredEvent | BlockedEvent | DegradedEvent | BookingEvent;

/**
 * The key a booking event is deduplicated by: the watch, the task and what
 * became of the watch. A task has one outcome, so a consequence applied
 * twice - by the hook and then the sweep, or by a sweep retried after a
 * delivery failed - is one event delivered twice.
 */
export function bookingDedupKey(watchId: string, taskId: string, outcome: BookingOutcome): string {
  return createHash('sha256')
    .update(JSON.stringify([watchId, 'booking', taskId, outcome]))
    .digest('hex');
}

export interface NotifierPort {
  notify(event: WatchEvent): Promise<void>;
}

export interface RecordingNotifier extends NotifierPort {
  /** Every delivery that succeeded, in order, redeliveries included. */
  readonly calls: readonly WatchEvent[];
  /** The first delivery of each dedup key, in order: what a person would see. */
  readonly events: readonly WatchEvent[];
  eventsFor(watchId: string): WatchEvent[];
  /** Rejects the next delivery with `error`, then behaves again. */
  failNextWith(error: Error): void;
}

export function createRecordingNotifier(): RecordingNotifier {
  const calls: WatchEvent[] = [];
  const events: WatchEvent[] = [];
  const seen = new Set<string>();
  let pendingFailure: Error | undefined;

  return {
    get calls() {
      return [...calls];
    },
    get events() {
      return [...events];
    },
    eventsFor(watchId) {
      return events.filter((event) => event.watchId === watchId);
    },
    failNextWith(error) {
      pendingFailure = error;
    },
    notify(event) {
      if (pendingFailure !== undefined) {
        const failure = pendingFailure;
        pendingFailure = undefined;
        return Promise.reject(failure);
      }
      calls.push(event);
      if (!seen.has(event.dedupKey)) {
        seen.add(event.dedupKey);
        events.push(event);
      }
      return Promise.resolve();
    },
  };
}
