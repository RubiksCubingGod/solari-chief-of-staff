import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDatabaseOn, type TestPostgres } from './postgres.js';

/**
 * The no-container rung of the test-database ladder: a real PostgreSQL cluster
 * started from the stock binaries `embedded-postgres` unpacks, in a temporary
 * directory, on an ephemeral port.
 *
 * This file is excluded from coverage (see `vitest.config.ts`) for the mirror
 * image of the reason `testcontainers.ts` is: CI has a Docker daemon, so CI
 * never takes this path, and a file only one side of the fence executes cannot
 * carry a coverage threshold honestly.
 *
 * The cluster is started at most once per process and shared: `initdb` costs
 * ~20 seconds, while creating a database on a running cluster costs
 * milliseconds. Isolation is unchanged — every suite still gets a uniquely
 * named database of its own, through the same `createDatabaseOn` the
 * `TEST_DATABASE_URL` rung uses.
 */

const CLUSTER_USER = 'postgres';
const CLUSTER_PASSWORD = 'postgres';

interface Cluster {
  readonly serverUrl: string;
  stop(): Promise<void>;
}

let starting: Promise<Cluster> | undefined;

export async function startEmbedded(): Promise<TestPostgres> {
  starting ??= startCluster();
  const cluster = await starting;
  return createDatabaseOn(cluster.serverUrl);
}

/**
 * Shuts the shared cluster down and forgets it, so a later call starts a fresh
 * one. Exported for the process-exit hook and for tests that need to prove the
 * lifecycle rather than inherit it.
 */
export async function stopEmbedded(): Promise<void> {
  const running = starting;
  if (running === undefined) return;
  starting = undefined;
  await (await running).stop();
}

async function startCluster(): Promise<Cluster> {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const directory = await mkdtemp(join(tmpdir(), 'chief-of-staff-pg-'));
  const port = await freePort();
  const postgres = new EmbeddedPostgres({
    databaseDir: join(directory, 'data'),
    port,
    user: CLUSTER_USER,
    password: CLUSTER_PASSWORD,
    authMethod: 'password',
    // The directory is a fresh mkdtemp every run, so there is nothing worth
    // keeping; false also makes `stop()` clear the data files itself.
    persistent: false,
    // A test run's output is the test report. The cluster's own chatter goes
    // nowhere unless it fails to start, in which case the rejection carries it.
    onLog: () => {},
    onError: () => {},
  });

  try {
    await postgres.initialise();
    await postgres.start();
  } catch (cause) {
    await rm(directory, { recursive: true, force: true });
    throw new Error(`the embedded Postgres cluster did not start: ${reason(cause)}`, { cause });
  }

  const stop = async (): Promise<void> => {
    try {
      await postgres.stop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };

  // A worker that finishes its files leaves the cluster running otherwise, and
  // the postgres process outlives the run that started it.
  process.once('beforeExit', () => {
    void stopEmbedded();
  });

  return {
    serverUrl: `postgres://${CLUSTER_USER}:${CLUSTER_PASSWORD}@127.0.0.1:${String(port)}/postgres`,
    stop,
  };
}

/**
 * A port the OS has just confirmed is free. Nothing can reserve a port for
 * somebody else, so this is a claim rather than a lock — but the window is the
 * few milliseconds before `postgres` binds it, and every caller here is a test
 * process on the same machine rather than a fleet racing for the same range.
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close(() => {
          reject(new Error('the port probe did not bind a TCP address'));
        });
        return;
      }
      const { port } = address;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

function reason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
