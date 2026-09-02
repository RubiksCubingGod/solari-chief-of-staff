import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type Database } from './client.js';
import { runMigrations } from './migrate.js';
import { SCHEMA_TABLE_NAMES, users, watches } from './schema.js';
import { startTestPostgres, type TestPostgres } from './testing/postgres.js';

let postgres: TestPostgres;
let database: Database;

beforeAll(async () => {
  postgres = await startTestPostgres();
  database = createDatabase(postgres.connectionString);
});

afterAll(async () => {
  await database.close();
  await postgres.stop();
});

function only<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error('expected exactly one returned row');
  return row;
}

async function publicTableNames(): Promise<string[]> {
  const result = await database.db.execute<{ table_name: string }>(
    sql`select table_name from information_schema.tables
        where table_schema = 'public' order by table_name`,
  );
  return result.rows.map(({ table_name: name }) => name);
}

async function appliedMigrationHashes(): Promise<string[]> {
  const result = await database.db.execute<{ hash: string }>(
    sql`select hash from drizzle.__drizzle_migrations order by created_at`,
  );
  return result.rows.map(({ hash }) => hash);
}

describe('the generated migration set', () => {
  it('creates every section 5 table on a fresh database', async () => {
    await runMigrations(postgres.connectionString);

    expect(await publicTableNames()).toEqual([...SCHEMA_TABLE_NAMES].sort());
  });

  it('re-applies as a no-op', async () => {
    const tablesBefore = await publicTableNames();
    const applied = await appliedMigrationHashes();
    expect(applied.length).toBeGreaterThan(0);

    await runMigrations(postgres.connectionString);

    expect(await appliedMigrationHashes()).toEqual(applied);
    expect(await publicTableNames()).toEqual(tablesBefore);
  });

  it('round-trips a row through the exported schema objects', async () => {
    const user = only(
      await database.db.insert(users).values({ telegramChatId: '4242' }).returning(),
    );
    const watch = only(
      await database.db
        .insert(watches)
        .values({
          userId: user.id,
          kind: 'price',
          url: 'https://example.test/widget',
          extractor: { selector: '.price', parse: 'price' },
          condition: { below_cents: 4999 },
          schedule: '*/15 * * * *',
        })
        .returning(),
    );

    expect(user.tz).toBe('UTC');
    expect(watch.tierPolicy).toBe('auto');
    expect(watch.status).toBe('active');
    // The engine's own columns start where a watch nobody has checked yet is:
    // healthy, at the bottom of the tier ladder, with nothing to report.
    expect(watch.health).toBe('healthy');
    expect(watch.tierFloor).toBe('http');
    expect(watch.lastError).toBeNull();
    expect(watch.consecutiveFailures).toBe(0);
    expect(watch.lastCheckedAt).toBeNull();
  });
});
