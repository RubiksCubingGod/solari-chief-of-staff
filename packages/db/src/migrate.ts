import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { createDatabase } from './client.js';

/**
 * The generated migration set, resolved relative to this module so it works the
 * same from `src` under Vitest and from `dist` in a built package.
 */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));

/**
 * Applies every pending migration. Drizzle records what it has already applied
 * in its own `drizzle.__drizzle_migrations` table, so a second call is a no-op
 * and start-up can run this unconditionally.
 */
export async function runMigrations(connectionString: string): Promise<void> {
  const database = createDatabase(connectionString);
  try {
    await migrate(database.db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await database.close();
  }
}
