import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase } from './client.js';
import { startTestPostgres, type TestPostgres } from './testing/postgres.js';

const started: TestPostgres[] = [];

async function start(): Promise<TestPostgres> {
  const postgres = await startTestPostgres();
  started.push(postgres);
  return postgres;
}

afterEach(async () => {
  for (const postgres of started.splice(0)) {
    await postgres.stop();
  }
});

describe('startTestPostgres', () => {
  it('answers a query through the shared Drizzle client', async () => {
    const postgres = await start();
    const database = createDatabase(postgres.connectionString);

    try {
      const result = await database.db.execute<{ one: number }>(sql`select 1 as one`);
      expect(result.rows[0]?.one).toBe(1);
    } finally {
      await database.close();
    }
  });

  it('gives each caller its own database so integration tests cannot see each other', async () => {
    const [first, second] = [await start(), await start()];
    const firstDatabase = createDatabase(first.connectionString);
    const secondDatabase = createDatabase(second.connectionString);

    try {
      await firstDatabase.db.execute(sql`create table only_in_first (id integer primary key)`);

      // Two callers must not share a database. Which half of the connection
      // differs depends on the path: a container per caller keeps the name `test`
      // and changes the port, while a shared TEST_DATABASE_URL server keeps the
      // port and changes the name. The whole string is what both paths change.
      expect(first.connectionString).not.toBe(second.connectionString);

      const visible = await secondDatabase.db.execute<{ count: number }>(
        sql`select count(*)::int as count from information_schema.tables where table_name = 'only_in_first'`,
      );
      expect(visible.rows[0]?.count).toBe(0);
    } finally {
      await Promise.all([firstDatabase.close(), secondDatabase.close()]);
    }
  });
});
