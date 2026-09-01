import { TEST_POSTGRES_IMAGE, type TestPostgres } from './postgres.js';

/**
 * Thin adapter over `@testcontainers/postgresql`.
 *
 * This file is the one place a container runtime is required, so it is excluded
 * from coverage (see `vitest.config.ts`): it cannot execute on a workstation
 * without Docker, and on CI — where Docker exists — it is the path every
 * integration test runs through.
 */
export async function startContainer(): Promise<TestPostgres> {
  // Imported lazily so a machine using TEST_DATABASE_URL never needs a
  // container runtime just to load this module.
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const container = await new PostgreSqlContainer(TEST_POSTGRES_IMAGE).start();
  return {
    connectionString: container.getConnectionUri(),
    stop: async () => {
      await container.stop();
    },
  };
}
