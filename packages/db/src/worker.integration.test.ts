import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { startTestPostgres, type TestPostgres } from './testing/postgres.js';
import { startWorker } from './worker.js';

/**
 * The worker process has no HTTP surface, so "it started" means: the harness is
 * running, every registration the deployment handed it is applied, and shutdown
 * returns rather than hanging.
 */

let postgres: TestPostgres;

beforeAll(async () => {
  postgres = await startTestPostgres();
});

afterAll(async () => {
  await postgres.stop();
});

describe('startWorker', () => {
  it('starts the harness, applies every registration, and stops cleanly', async () => {
    const queue = `worker-entry-${randomUUID().slice(0, 8)}`;
    const seen: unknown[] = [];
    const worker = await startWorker(
      { connectionString: postgres.connectionString, pollingIntervalSeconds: 0.5 },
      [
        (harness) =>
          harness.register(queue, (payload) => {
            seen.push(payload);
            return Promise.resolve();
          }),
      ],
    );

    const id = await worker.harness.enqueue(queue, { ok: true });
    await vi.waitFor(
      async () => {
        expect((await worker.harness.inspect(queue, id))?.state).toBe('completed');
      },
      { timeout: 20_000, interval: 100 },
    );

    await expect(worker.stop()).resolves.toBeUndefined();
    expect(seen).toEqual([{ ok: true }]);
  });

  it('starts with no registrations, so the process exists before its first engine does', async () => {
    const worker = await startWorker({ connectionString: postgres.connectionString });

    await expect(worker.stop()).resolves.toBeUndefined();
  });
});
