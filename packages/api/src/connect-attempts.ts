import { randomUUID } from 'node:crypto';

import type { BrowserProfile, ProfileStore } from '@chief-of-staff/solari';

/**
 * The in-flight half of connecting a site: a profile minted for a person to
 * log into, held open until they confirm, cancel, or time out.
 *
 * Kept in memory rather than in a table, on purpose. An attempt is a promise
 * the server made to clean up a vendor profile if nobody claims it, and a
 * promise a restarted process cannot see is one it cannot keep; a table would
 * make the orphans durable without making anyone responsible for them. So an
 * attempt lives exactly as long as the process that minted its profile, and
 * closing the app deletes every profile still waiting. What a person loses on
 * a restart is a login they had not yet confirmed, which the dashboard tells
 * them to redo. What nobody loses is a profile counting against the plan's cap.
 *
 * The one durable thing - the `site_connections` row - is written by the
 * caller inside `confirm`, so the attempt cannot close before the row exists.
 */

export type ConnectAttemptStatus = 'started' | 'confirmed' | 'cancelled' | 'expired';

export interface ConnectAttempt {
  readonly id: string;
  readonly userId: string;
  readonly siteDomain: string;
  readonly status: ConnectAttemptStatus;
  readonly profile: BrowserProfile;
  readonly startedAt: Date;
  readonly expiresAt: Date;
}

export interface ConnectAttemptLedgerOptions {
  readonly store: ProfileStore;
  /** How long an attempt stays open. After it, the profile is deleted unclaimed. */
  readonly timeoutMs: number;
  /** Where a failed clean-up is reported. Nothing else is done about it. */
  readonly warn?: (message: string, error: unknown) => void;
}

export interface ConnectAttemptLedger {
  /** Mints a profile and opens an attempt around it. Vendor refusals pass through. */
  start(userId: string, siteDomain: string): Promise<ConnectAttempt>;
  /** The attempt by id, if this user opened it. Terminal attempts are readable briefly. */
  read(userId: string, id: string): ConnectAttempt | undefined;
  /**
   * Closes an open attempt as confirmed, once `commit` has made the profile
   * durable. A commit that throws leaves the attempt open, so a database that
   * was away for a moment does not cost the person their login.
   */
  confirm(
    userId: string,
    id: string,
    commit: (attempt: ConnectAttempt) => Promise<void>,
  ): Promise<ConnectAttempt | undefined>;
  /** Closes an open attempt and deletes its profile. False when nothing was open. */
  cancel(userId: string, id: string): Promise<boolean>;
  /** Cancels every open attempt: the server is going away and cannot watch them. */
  close(): Promise<void>;
}

interface Held {
  attempt: ConnectAttempt;
  timer: NodeJS.Timeout | undefined;
}

/**
 * How long a closed attempt stays readable, so a page drawn late sees why it
 * closed rather than a 404. Independent of the timeout: a short timeout is a
 * reason to keep the explanation longer, not shorter.
 */
const CLOSED_ATTEMPT_RETENTION_MS = 15 * 60 * 1000;

/** How a profile is named for the person to find in the console's list. */
export function profileNameFor(siteDomain: string, attemptId: string): string {
  return `${siteDomain} (${attemptId.slice(0, 8)})`;
}

export function createConnectAttemptLedger(options: ConnectAttemptLedgerOptions): ConnectAttemptLedger {
  const { store, timeoutMs } = options;
  const warn = options.warn ?? (() => undefined);
  const held = new Map<string, Held>();

  async function discard(entry: Held, status: ConnectAttemptStatus): Promise<void> {
    entry.attempt = { ...entry.attempt, status };
    try {
      await store.delete(entry.attempt.profile.id);
    } catch (error) {
      // Reported, not retried: the profile is the vendor's to count and this
      // ledger's promise was best effort. The operator sees it in the log.
      warn(`could not delete the profile of ${status} connect attempt ${entry.attempt.id}`, error);
    }
    forget(entry);
  }

  /** A closed attempt stays readable for a while, so a late page load sees why. */
  function forget(entry: Held): void {
    const timer = setTimeout(() => held.delete(entry.attempt.id), CLOSED_ATTEMPT_RETENTION_MS);
    timer.unref();
  }

  function arm(entry: Held): void {
    const remaining = Math.max(0, entry.attempt.expiresAt.getTime() - Date.now());
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void discard(entry, 'expired');
    }, remaining);
    // The server, not this timer, decides how long the process lives.
    entry.timer.unref();
  }

  function disarm(entry: Held): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = undefined;
  }

  function open(userId: string, id: string): Held | undefined {
    const entry = held.get(id);
    if (entry === undefined || entry.attempt.userId !== userId) return undefined;
    return entry.attempt.status === 'started' ? entry : undefined;
  }

  return {
    async start(userId, siteDomain) {
      const id = randomUUID();
      const profile = await store.create(profileNameFor(siteDomain, id));
      const startedAt = new Date();
      const entry: Held = {
        attempt: {
          id,
          userId,
          siteDomain,
          status: 'started',
          profile,
          startedAt,
          expiresAt: new Date(startedAt.getTime() + timeoutMs),
        },
        timer: undefined,
      };
      held.set(id, entry);
      arm(entry);
      return entry.attempt;
    },

    read(userId, id) {
      const entry = held.get(id);
      return entry?.attempt.userId === userId ? entry.attempt : undefined;
    },

    async confirm(userId, id, commit) {
      const entry = open(userId, id);
      if (entry === undefined) return undefined;
      // Off the clock while the row is written, so a slow commit cannot race
      // the timeout into deleting a profile the row is about to name.
      disarm(entry);
      try {
        await commit(entry.attempt);
      } catch (error) {
        arm(entry);
        throw error;
      }
      entry.attempt = { ...entry.attempt, status: 'confirmed' };
      forget(entry);
      return entry.attempt;
    },

    async cancel(userId, id) {
      const entry = open(userId, id);
      if (entry === undefined) return false;
      disarm(entry);
      await discard(entry, 'cancelled');
      return true;
    },

    async close() {
      const waiting = [...held.values()].filter((entry) => entry.attempt.status === 'started');
      for (const entry of waiting) disarm(entry);
      await Promise.all(waiting.map((entry) => discard(entry, 'cancelled')));
      held.clear();
    },
  };
}
