import { getTableName } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  SCHEMA_TABLE_NAMES,
  calendarItems,
  messages,
  observations,
  siteConnections,
  taskEvents,
  tasks,
  users,
  watches,
} from './schema.js';

const TABLES: PgTable[] = [
  users,
  siteConnections,
  watches,
  observations,
  tasks,
  taskEvents,
  calendarItems,
  messages,
];

interface ForeignKeyShape {
  readonly columns: string[];
  readonly onDelete: string | undefined;
  readonly references: string;
}

function foreignKeys(table: PgTable): ForeignKeyShape[] {
  return getTableConfig(table)
    .foreignKeys.map((key) => {
      const reference = key.reference();
      return {
        columns: reference.columns.map((column) => column.name),
        onDelete: key.onDelete,
        references: getTableName(reference.foreignTable),
      };
    })
    .sort((left, right) => left.columns.join().localeCompare(right.columns.join()));
}

type IndexColumn = ReturnType<typeof getTableConfig>['indexes'][number]['config']['columns'][number];

/** Raw SQL expressions are not part of this schema, so only named columns matter. */
function columnNames(columns: readonly IndexColumn[]): string[] {
  return columns.flatMap((column) =>
    'name' in column && typeof column.name === 'string' ? [column.name] : [],
  );
}

function indexedColumns(table: PgTable): Record<string, string[]> {
  const entries = getTableConfig(table).indexes.map(
    (index): [string, string[]] => [
      index.config.name ?? '(unnamed)',
      columnNames(index.config.columns),
    ],
  );
  return Object.fromEntries(entries);
}

describe('the section 5 schema', () => {
  it('declares every table listed in SCHEMA_TABLE_NAMES, and no others', () => {
    expect(TABLES.map((table) => getTableName(table))).toEqual([...SCHEMA_TABLE_NAMES]);
  });

  it('deletes a user by cascading through everything the user owns', () => {
    for (const table of [siteConnections, watches, tasks, calendarItems, messages]) {
      expect(foreignKeys(table)).toContainEqual({
        columns: ['user_id'],
        onDelete: 'cascade',
        references: 'users',
      });
    }
    expect(foreignKeys(observations)).toEqual([
      { columns: ['watch_id'], onDelete: 'cascade', references: 'watches' },
    ]);
    expect(foreignKeys(taskEvents)).toEqual([
      { columns: ['task_id'], onDelete: 'cascade', references: 'tasks' },
    ]);
  });

  it('keeps a transcript row after the task or watch it answered is gone', () => {
    expect(foreignKeys(messages)).toContainEqual({
      columns: ['task_id'],
      onDelete: 'set null',
      references: 'tasks',
    });
    expect(foreignKeys(messages)).toContainEqual({
      columns: ['watch_id'],
      onDelete: 'set null',
      references: 'watches',
    });
  });

  it('indexes the read paths the dashboard and the resume path depend on', () => {
    expect(indexedColumns(watches)).toEqual({ watches_user_id_idx: ['user_id'] });
    expect(indexedColumns(observations)).toEqual({
      observations_watch_id_checked_at_idx: ['watch_id', 'checked_at'],
    });
    expect(indexedColumns(taskEvents)).toEqual({
      task_events_task_id_ts_idx: ['task_id', 'ts'],
    });
    expect(indexedColumns(messages)).toEqual({ messages_user_id_ts_idx: ['user_id', 'ts'] });
    expect(indexedColumns(tasks)).toEqual({
      tasks_user_id_created_at_idx: ['user_id', 'created_at'],
    });
    expect(indexedColumns(calendarItems)).toEqual({
      calendar_items_user_id_idx: ['user_id'],
    });
  });

  it('allows one stored login per site per user', () => {
    const [unique] = getTableConfig(siteConnections).indexes;
    expect(unique?.config.unique).toBe(true);
    expect(columnNames(unique?.config.columns ?? [])).toEqual(['user_id', 'site_domain']);
  });
});
