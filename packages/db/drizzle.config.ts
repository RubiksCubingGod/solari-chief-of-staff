import { defineConfig } from 'drizzle-kit';

/**
 * Generation-time configuration only. Migrations are applied by
 * `runMigrations` at start-up and in tests, never by `drizzle-kit push`, so the
 * committed SQL in `drizzle/` is the single source of truth for the database.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
});
