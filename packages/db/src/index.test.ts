import { getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import * as db from './index.js';

describe('@chief-of-staff/db', () => {
  it('exposes the shared client factory and the migration runner', () => {
    expect(typeof db.createDatabase).toBe('function');
    expect(typeof db.runMigrations).toBe('function');
  });

  it('exports one table object per section 5 table, under its SQL name', () => {
    const exported = Object.values(db).filter((value) => value instanceof Object);
    const tableNames = exported
      .filter((value) => Reflect.has(value, Symbol.for('drizzle:Name')))
      .map((table) => getTableName(table as Parameters<typeof getTableName>[0]));

    expect(tableNames.sort()).toEqual([...db.SCHEMA_TABLE_NAMES].sort());
  });
});
