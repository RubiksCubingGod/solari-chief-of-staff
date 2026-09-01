import { describe, expect, it } from 'vitest';

import { createDatabase, logPoolError } from './client.js';

/**
 * A pooled connection can fail while nobody is using it - Postgres restarts, a
 * failover promotes a replica, a proxy drops an idle socket. `pg` reports that
 * on the pool's `error` event, and an EventEmitter that emits `error` with no
 * listener terminates the process. This is the one Postgres handle the API and
 * every worker share, so an unhandled event here takes down an agent whose
 * whole point is staying up.
 */

/** Never connected to: these tests only exercise the event, not the socket. */
const UNREACHABLE = 'postgres://nobody@127.0.0.1:1/none';

describe('createDatabase', () => {
  it('reports a pool error rather than letting it terminate the process', async () => {
    const seen: string[] = [];
    const database = createDatabase(UNREACHABLE, (error) => seen.push(error.message));

    expect(() =>
      database.pool.emit('error', new Error('Connection terminated unexpectedly')),
    ).not.toThrow();
    expect(seen).toEqual(['Connection terminated unexpectedly']);

    await database.close();
  });

  it('attaches a listener even when the caller supplies none', async () => {
    const database = createDatabase(UNREACHABLE);

    expect(database.pool.listenerCount('error')).toBe(1);

    await database.close();
  });
});

describe('logPoolError', () => {
  it('writes the failure somewhere an operator can see it', () => {
    const lines: string[] = [];

    logPoolError(new Error('terminating connection due to administrator command'), (line) =>
      lines.push(line),
    );

    expect(lines).toEqual([
      '[db] postgres pool reported an error: terminating connection due to administrator command',
    ]);
  });

  it('defaults to the process error stream', () => {
    const written: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]): void => {
      written.push(args[0]);
    };

    try {
      logPoolError(new Error('read ECONNRESET'));
    } finally {
      console.error = original;
    }

    expect(written).toEqual(['[db] postgres pool reported an error: read ECONNRESET']);
  });
});
