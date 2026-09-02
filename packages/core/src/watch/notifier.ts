import type { FetchTier, WatchKind } from '../index.js';
import type { WatchCondition } from './condition.js';
import type { WatchValue } from './value.js';

/**
 * The notifier port: the seam this sprint ends at.
 *
 * The engine tells a person three things - a watch triggered, a watch is
 * blocked at every tier, a watch has degraded past its healing budget - and it
 * tells them through this interface. The recording double below is what every
 * pipeline proof asserts against; calendar-wiring (s7) implements the port
 * over the bot's outbound door.
 */

export const WATCH_EVENT_TYPES = ['triggered', 'blocked', 'degraded'] as const;
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

export type WatchEvent = TriggeredEvent | BlockedEvent | DegradedEvent;

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
