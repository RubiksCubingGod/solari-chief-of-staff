import { getTableName } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  SCHEMA_TABLE_NAMES,
  bindingCodes,
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
  bindingCodes,
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
    expect(indexedColumns(messages)).toEqual({
      messages_user_id_ts_idx: ['user_id', 'ts'],
      // A chat is readable before it is anybody's: an unbound stranger's
      // messages have no user_id to be found by, and reading that exchange back
      // is the whole point of transcribing it.
      messages_chat_id_ts_idx: ['chat_id', 'ts'],
    });
    expect(indexedColumns(tasks)).toEqual({
      tasks_user_id_created_at_idx: ['user_id', 'created_at'],
    });
    expect(indexedColumns(calendarItems)).toEqual({
      calendar_items_user_id_idx: ['user_id'],
    });
    expect(indexedColumns(bindingCodes)).toEqual({
      binding_codes_user_id_idx: ['user_id'],
    });
  });

  it('transcribes a chat that belongs to nobody yet', () => {
    const columns = Object.fromEntries(
      getTableConfig(messages).columns.map((column) => [column.name, column]),
    );

    // The two halves of one decision. A stranger's first message arrives before
    // any user exists to attribute it to, so `user_id` cannot be required; and
    // `chat_id` is then the only handle that exchange has, so it has to be
    // stored rather than inferred from a row that is not there.
    expect(columns['user_id']?.notNull).toBe(false);
    expect(columns['chat_id']).toBeDefined();
    // The text itself stays required: a transcript row that records nothing is
    // worse than no row, because it looks like evidence.
    expect(columns['text']?.notNull).toBe(true);
  });

  it('lets a user exist before any chat is bound to them', () => {
    const columns = Object.fromEntries(
      getTableConfig(users).columns.map((column) => [column.name, column]),
    );

    // A binding code is issued for a user who has not sent `/start` yet, so a
    // required chat id would mean no user could be created to issue one for.
    expect(columns['telegram_chat_id']?.notNull).toBe(false);
    // Still at most one user per chat, which is what makes "who is this chat"
    // a question with one answer. Postgres permits many nulls in a unique
    // index, so the two properties do not conflict.
    expect(columns['telegram_chat_id']?.isUnique).toBe(true);
  });

  it('spends a binding code rather than deleting it', () => {
    const columns = Object.fromEntries(
      getTableConfig(bindingCodes).columns.map((column) => [column.name, column]),
    );

    // Nullable, and the whole of single use: a spent code is still there to be
    // found, so a second attempt is answered differently from a code that never
    // existed - which is what a person who sent theirs twice needs to hear.
    expect(columns['consumed_at']?.notNull).toBe(false);
    expect(columns['expires_at']?.notNull).toBe(true);
    // Unique, or redemption would be ambiguous at the moment it must not be.
    expect(columns['code']?.isUnique).toBe(true);
  });

  it('allows one stored login per site per user', () => {
    const [unique] = getTableConfig(siteConnections).indexes;
    expect(unique?.config.unique).toBe(true);
    expect(columnNames(unique?.config.columns ?? [])).toEqual(['user_id', 'site_domain']);
  });
});
