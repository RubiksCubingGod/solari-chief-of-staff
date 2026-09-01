import { getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import * as db from './index.js';

describe('@chief-of-staff/db', () => {
  it('exposes the shared client factory, the migration runner, and the job harness', () => {
    expect(typeof db.createDatabase).toBe('function');
    expect(typeof db.logPoolError).toBe('function');
    expect(typeof db.runMigrations).toBe('function');
    expect(typeof db.createJobHarness).toBe('function');
    expect(typeof db.runWorker).toBe('function');
    expect(db.DEFAULT_RETRY_POLICY).toEqual({ retryLimit: 3, retryDelaySeconds: 5 });
  });

  it('exports one table object per section 5 table, under its SQL name', () => {
    const exported = Object.values(db).filter((value) => value instanceof Object);
    const tableNames = exported
      .filter((value) => Reflect.has(value, Symbol.for('drizzle:Name')))
      .map((table) => getTableName(table as Parameters<typeof getTableName>[0]));

    expect(tableNames.sort()).toEqual([...db.SCHEMA_TABLE_NAMES].sort());
  });
});
