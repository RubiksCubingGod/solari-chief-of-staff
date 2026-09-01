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

/**
 * `pg` reports a connection that failed while idle on the pool's `error` event
 * rather than by rejecting anything a caller is awaiting, and an EventEmitter
 * that emits `error` with no listener terminates the process. The pool always
 * gets a listener for the same reason the job harness does.
 */
export function logPoolError(
  error: Error,
  write: (line: string) => void = (line) => {
    console.error(line);
  },
): void {
  write(`[db] postgres pool reported an error: ${error.message}`);
}

export function createDatabase(
  connectionString: string,
  onError: (error: Error) => void = logPoolError,
): Database {
  const pool = new Pool({ connectionString });
  pool.on('error', onError);
  return {
    db: drizzle(pool),
    pool,
    close: async () => {
      await pool.end();
    },
  };
}
