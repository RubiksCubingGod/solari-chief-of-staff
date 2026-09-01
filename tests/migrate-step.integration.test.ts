import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { SCHEMA_TABLE_NAMES, createDatabase } from '@chief-of-staff/db';
import { startTestPostgres, type TestPostgres } from '@chief-of-staff/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

let postgres: TestPostgres;

beforeAll(async () => {
  postgres = await startTestPostgres();
});

afterAll(async () => {
  await postgres.stop();
});

/**
 * `pnpm migrate` is the third step of the documented setup, so it has to work
 * from a clean checkout on an empty database - including building the package
 * whose migration runner it uses, which nothing has built yet at that point.
 */
function migrate(environment: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ['scripts/migrate.mjs'], {
    cwd: repositoryRoot,
    env: environment,
    encoding: 'utf8',
  });
}

async function tableNames(): Promise<string[]> {
  const database = createDatabase(postgres.connectionString);
  try {
    const { rows } = await database.pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by 1",
    );
    return rows.map((row) => row.table_name);
  } finally {
    await database.close();
  }
}

describe('pnpm migrate', () => {
  it('brings an empty database up to the section 5 model, then changes nothing', async () => {
    const environment = { ...process.env, DATABASE_URL: postgres.connectionString };

    const first = migrate(environment);
    expect(`${first.stdout}${first.stderr}`).toContain('the database is up to date');
    expect(first.status).toBe(0);

    const created = await tableNames();
    expect(created).toEqual(expect.arrayContaining([...SCHEMA_TABLE_NAMES]));

    const second = migrate(environment);
    expect(second.status).toBe(0);
    await expect(tableNames()).resolves.toEqual(created);
  }, 180_000);

  it('says what is missing instead of failing somewhere deeper', () => {
    const environment = { ...process.env };
    delete environment['DATABASE_URL'];

    const result = migrate(environment);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DATABASE_URL is not set');
  }, 180_000);
});
