import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

import { startContainer } from './testcontainers.js';

/**
 * A Postgres instance owned by exactly one integration test.
 */
export interface TestPostgres {
  readonly connectionString: string;
  stop(): Promise<void>;
}

/**
 * The two ways a test database can be obtained. Injectable so the choice
 * between them is testable without a container runtime.
 */
export interface TestPostgresStarters {
  container(): Promise<TestPostgres>;
  server(serverUrl: string): Promise<TestPostgres>;
}

export const TEST_DATABASE_URL_VARIABLE = 'TEST_DATABASE_URL';
export const TEST_POSTGRES_IMAGE = 'postgres:17-alpine';

/**
 * Resolution order:
 *
 * 1. `TEST_DATABASE_URL` — an already-running server. A uniquely named database
 *    is created on it and dropped in `stop()`, so tests sharing one server
 *    still cannot see each other. This is the path on machines with no
 *    container runtime.
 * 2. Testcontainers — a throwaway `postgres:17-alpine` container. This is the
 *    default and what CI runs (ARCHITECTURE §9.2).
 */
export async function startTestPostgres(
  environment: NodeJS.ProcessEnv = process.env,
  starters: TestPostgresStarters = defaultStarters,
): Promise<TestPostgres> {
  const serverUrl = environment[TEST_DATABASE_URL_VARIABLE];
  return serverUrl === undefined || serverUrl.trim() === ''
    ? starters.container()
    : starters.server(serverUrl);
}

export const defaultStarters: TestPostgresStarters = {
  container: startContainer,
  server: createDatabaseOn,
};

export async function createDatabaseOn(serverUrl: string): Promise<TestPostgres> {
  // Hex from randomUUID only, so the identifier cannot carry anything but
  // [a-f0-9_] into the DDL below.
  const name = `nah_test_${randomUUID().replaceAll('-', '')}`;

  await withAdminClient(serverUrl, async (admin) => {
    await admin.query(`create database "${name}"`);
  });

  const url = new URL(serverUrl);
  url.pathname = `/${name}`;

  return {
    connectionString: url.toString(),
    stop: async () => {
      await withAdminClient(serverUrl, async (admin) => {
        // Pooled connections can outlive the test that opened them, and
        // Postgres refuses to drop a database anything is still attached to.
        await admin.query(
          'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1',
          [name],
        );
        await admin.query(`drop database if exists "${name}"`);
      });
    },
  };
}

async function withAdminClient(
  serverUrl: string,
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const client = new Client({ connectionString: serverUrl });
  await client.connect();
  try {
    await run(client);
  } finally {
    await client.end();
  }
}
