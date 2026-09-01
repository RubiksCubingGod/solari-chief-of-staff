import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

import { startEmbedded } from './embedded.js';
import { startContainer } from './testcontainers.js';

/**
 * A Postgres instance owned by exactly one integration test.
 */
export interface TestPostgres {
  readonly connectionString: string;
  stop(): Promise<void>;
}

/**
 * The three ways a test database can be obtained. Injectable so the choice
 * between them is testable without a container runtime.
 */
export interface TestPostgresStarters {
  container(): Promise<TestPostgres>;
  embedded(): Promise<TestPostgres>;
  server(serverUrl: string): Promise<TestPostgres>;
}

export const TEST_DATABASE_URL_VARIABLE = 'TEST_DATABASE_URL';
export const TEST_POSTGRES_STARTER_VARIABLE = 'TEST_POSTGRES_STARTER';
export const TEST_POSTGRES_IMAGE = 'postgres:17-alpine';

/** The rungs `TEST_POSTGRES_STARTER` can pin, when the ladder is not wanted. */
export const TEST_POSTGRES_STARTERS = ['server', 'container', 'embedded'] as const;
export type TestPostgresStarterName = (typeof TEST_POSTGRES_STARTERS)[number];

/**
 * Resolution order:
 *
 * 1. `TEST_DATABASE_URL` — an already-running server. A uniquely named database
 *    is created on it and dropped in `stop()`, so tests sharing one server
 *    still cannot see each other.
 * 2. Testcontainers — a throwaway `postgres:17-alpine` container. This is what
 *    CI runs (ARCHITECTURE §9.2).
 * 3. An embedded cluster — the stock PostgreSQL 17 binaries, started in a
 *    temporary directory on an ephemeral port. Reached only when step 2 finds
 *    no container runtime, so a clone with neither Docker nor a spare Postgres
 *    still runs the integration suite instead of asking someone for a
 *    connection string.
 *
 * `TEST_POSTGRES_STARTER` pins one rung and disables the fallback, which is how
 * a machine that *has* Docker reproduces what a machine without it does.
 */
export async function startTestPostgres(
  environment: NodeJS.ProcessEnv = process.env,
  starters: TestPostgresStarters = defaultStarters,
): Promise<TestPostgres> {
  const serverUrl = configured(environment, TEST_DATABASE_URL_VARIABLE);
  const pinned = pinnedStarter(environment);

  if (pinned !== undefined) {
    if (pinned !== 'server') return starters[pinned]();
    if (serverUrl === undefined) {
      throw new Error(
        `${TEST_POSTGRES_STARTER_VARIABLE}=server requires ${TEST_DATABASE_URL_VARIABLE} to be set.`,
      );
    }
    return starters.server(serverUrl);
  }

  if (serverUrl !== undefined) return starters.server(serverUrl);

  try {
    return await starters.container();
  } catch (containerFailure) {
    try {
      return await starters.embedded();
    } catch (embeddedFailure) {
      // Both rungs are reported at once. Fixing the container error only to be
      // told about the embedded one is two round trips for one broken machine.
      throw new Error(
        [
          'No test database could be started.',
          `  container: ${reason(containerFailure)}`,
          `  embedded: ${reason(embeddedFailure)}`,
          `Set ${TEST_DATABASE_URL_VARIABLE} to a Postgres server to use one directly.`,
        ].join('\n'),
        { cause: embeddedFailure },
      );
    }
  }
}

function configured(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = environment[name];
  return value === undefined || value.trim() === '' ? undefined : value;
}

function pinnedStarter(environment: NodeJS.ProcessEnv): TestPostgresStarterName | undefined {
  const value = configured(environment, TEST_POSTGRES_STARTER_VARIABLE);
  if (value === undefined) return undefined;
  const match = TEST_POSTGRES_STARTERS.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new Error(
      `${TEST_POSTGRES_STARTER_VARIABLE} must be one of ${TEST_POSTGRES_STARTERS.join(', ')}, got '${value}'.`,
    );
  }
  return match;
}

function reason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export const defaultStarters: TestPostgresStarters = {
  container: startContainer,
  embedded: startEmbedded,
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
