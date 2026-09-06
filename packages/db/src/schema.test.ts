import { getTableName } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  SCHEMA_TABLE_NAMES,
  bindingCodes,
  calendarAutoCancels,
  calendarItems,
  calendarReminders,
  deliveries,
  loginTokens,
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
  loginTokens,
  deliveries,
  calendarReminders,
  calendarAutoCancels,
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
    for (const table of [
      siteConnections,
      watches,
      tasks,
      calendarItems,
      messages,
      bindingCodes,
      loginTokens,
      deliveries,
    ]) {
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

  it('takes an entry’s reminders and auto-cancel records with it, but keeps them when the task or delivery goes', () => {
    expect(foreignKeys(calendarReminders)).toEqual([
      { columns: ['delivery_id'], onDelete: 'set null', references: 'deliveries' },
      { columns: ['item_id'], onDelete: 'cascade', references: 'calendar_items' },
    ]);
    expect(foreignKeys(calendarAutoCancels)).toEqual([
      { columns: ['item_id'], onDelete: 'cascade', references: 'calendar_items' },
      { columns: ['task_id'], onDelete: 'set null', references: 'tasks' },
    ]);
  });

  it('keys one reminder per entry and day and one auto-cancel per entry and renewal', () => {
    for (const [table, name, columns] of [
      [calendarReminders, 'calendar_reminders_item_id_due_on_key', ['item_id', 'due_on']],
      [calendarAutoCancels, 'calendar_auto_cancels_item_id_renew_on_key', ['item_id', 'renew_on']],
    ] as const) {
      expect(indexedColumns(table)).toEqual({ [name]: columns });
      // Unique, or the key would be a hint rather than the idempotence it is
      // there to be: two scans could each record the same reminder.
      expect(getTableConfig(table).indexes.map((index) => index.config.unique)).toEqual([true]);
    }
  });

  it('gives an entry its reminder settings, off the safe end of each', () => {
    const columns = Object.fromEntries(
      getTableConfig(calendarItems).columns.map((column) => [column.name, column]),
    );

    expect(columns['reminder_lead_days']?.default).toBe(3);
    // Off by default: the one setting that can end a subscription is chosen,
    // never inherited.
    expect(columns['auto_cancel']?.default).toBe(false);
    expect(columns['auto_cancel_lead_days']?.default).toBe(3);
    // Unmarked until an engine marks it; the note and time travel with the mark.
    expect(columns['annotation']?.notNull).toBe(false);
    expect(columns['annotation_note']?.notNull).toBe(false);
    expect(columns['annotated_at']?.notNull).toBe(false);
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
    expect(indexedColumns(deliveries)).toEqual({
      deliveries_user_id_created_at_idx: ['user_id', 'created_at'],
      // One key is one delivery: the watch engine's notifier is at-least-once,
      // and the unique index is what makes two sends of one key one row even
      // when they land together.
      deliveries_dedup_key_key: ['dedup_key'],
    });
    expect(indexedColumns(loginTokens)).toEqual({
      login_tokens_user_id_idx: ['user_id'],
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

  it('records a delivery that was owed before it records what became of it', () => {
    const columns = Object.fromEntries(
      getTableConfig(deliveries).columns.map((column) => [column.name, column]),
    );

    // Written before the send and settled after it, so a process killed
    // mid-send leaves a row saying a message was owed. `settled_at` is null for
    // exactly that window, which is what makes a stuck delivery findable.
    expect(columns['status']?.default).toBe('pending');
    expect(columns['settled_at']?.notNull).toBe(false);
    expect(columns['attempts']?.notNull).toBe(true);
    // The address at the time of sending, not a join to wherever the user lives
    // now: a rebind must not make an old delivery read as having gone there.
    expect(columns['chat_id']?.notNull).toBe(true);
  });

  it('orders a task trail by a sequence Postgres hands out, and remembers the job that owns a run', () => {
    const eventColumns = Object.fromEntries(
      getTableConfig(taskEvents).columns.map((column) => [column.name, column]),
    );
    const taskColumns = Object.fromEntries(
      getTableConfig(tasks).columns.map((column) => [column.name, column]),
    );

    // Two events written in one transaction share a `ts`; an ask writes two.
    // The identity column is assigned by the database and never ties, so the
    // timeline can always say which came first.
    expect(eventColumns['seq']?.notNull).toBe(true);
    expect(eventColumns['seq']?.generatedIdentity?.type).toBe('always');
    // Null until a run is enqueued, which is how the reconcile sweep tells a
    // task the API created from one a worker is already entitled to.
    expect(taskColumns['job_id']?.notNull).toBe(false);
  });

  it('addresses a user by an email nobody else can also hold', () => {
    const columns = Object.fromEntries(
      getTableConfig(users).columns.map((column) => [column.name, column]),
    );

    // A seeded user exists before anyone has said where to write to them, so
    // the address cannot be required. It still has to resolve to one account:
    // `POST /auth/request-link` turns an address into the user a link is minted
    // for, and two rows sharing one address would make that question ambiguous
    // at the moment it must not be. Postgres permits many nulls in a unique
    // index, so the two properties do not conflict.
    expect(columns['email']?.notNull).toBe(false);
    expect(columns['email']?.isUnique).toBe(true);
  });

  it('stores a magic link as a digest and spends it rather than deleting it', () => {
    const columns = Object.fromEntries(
      getTableConfig(loginTokens).columns.map((column) => [column.name, column]),
    );

    // The token itself is never stored: it is the whole credential, so a
    // database that leaked would otherwise be a database that can mint working
    // links. Only its one-way digest is here, which is also what makes a
    // tampered token refusable — it simply digests to something no row carries.
    expect(columns['token']).toBeUndefined();
    expect(columns['token_digest']?.notNull).toBe(true);
    expect(columns['token_digest']?.isUnique).toBe(true);
    // Nullable, and the whole of single use: a spent token is still there, so a
    // second visit is answered differently from a link that never existed, and
    // one UPDATE filtering on it being null is what makes a race have one
    // winner.
    expect(columns['consumed_at']?.notNull).toBe(false);
    expect(columns['expires_at']?.notNull).toBe(true);
  });

  it('allows one stored login per site per user', () => {
    const [unique] = getTableConfig(siteConnections).indexes;
    expect(unique?.config.unique).toBe(true);
    expect(columnNames(unique?.config.columns ?? [])).toEqual(['user_id', 'site_domain']);
  });
});
