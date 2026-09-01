import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

/**
 * The one Postgres handle every process shares: API routes, workers, and
 * integration tests all reach Postgres through this, so pooling and connection
 * behaviour are configured in a single place (ARCHITECTURE §2).
 */
export interface Database {
  readonly db: NodePgDatabase<Record<string, never>>;
  readonly pool: Pool;
  close(): Promise<void>;
}

export function createDatabase(connectionString: string): Database {
  const pool = new Pool({ connectionString });
  return {
    db: drizzle(pool),
    pool,
    close: async () => {
      await pool.end();
    },
  };
}
