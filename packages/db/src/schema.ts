import {
  CALENDAR_ITEM_KINDS,
  CALENDAR_ITEM_STATUSES,
  DELIVERY_STATUSES,
  FETCH_TIERS,
  MESSAGE_CHANNELS,
  MESSAGE_DIRECTIONS,
  SITE_CONNECTION_STATUSES,
  TASK_EVENT_TYPES,
  TASK_KINDS,
  TASK_MODES,
  TASK_STATUSES,
  TIER_POLICIES,
  WATCH_KINDS,
  WATCH_STATUSES,
} from '@chief-of-staff/core';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * The ARCHITECTURE section 5 data model. Every closed-vocabulary column is a
 * Postgres enum built from the matching `@chief-of-staff/core` constant, so the
 * database and the domain cannot drift apart without a compile error here.
 */

export const watchKind = pgEnum('watch_kind', WATCH_KINDS);
export const watchStatus = pgEnum('watch_status', WATCH_STATUSES);
export const tierPolicy = pgEnum('tier_policy', TIER_POLICIES);
export const fetchTier = pgEnum('fetch_tier', FETCH_TIERS);
export const siteConnectionStatus = pgEnum('site_connection_status', SITE_CONNECTION_STATUSES);
export const taskKind = pgEnum('task_kind', TASK_KINDS);
export const taskStatus = pgEnum('task_status', TASK_STATUSES);
export const taskMode = pgEnum('task_mode', TASK_MODES);
export const taskEventType = pgEnum('task_event_type', TASK_EVENT_TYPES);
export const calendarItemKind = pgEnum('calendar_item_kind', CALENDAR_ITEM_KINDS);
export const calendarItemStatus = pgEnum('calendar_item_status', CALENDAR_ITEM_STATUSES);
export const messageDirection = pgEnum('message_direction', MESSAGE_DIRECTIONS);
export const messageChannel = pgEnum('message_channel', MESSAGE_CHANNELS);
export const deliveryStatus = pgEnum('delivery_status', DELIVERY_STATUSES);

const primaryKeyColumn = () => uuid('id').primaryKey().defaultRandom();
const timestampColumn = (name: string) => timestamp(name, { withTimezone: true });

export const users = pgTable('users', {
  id: primaryKeyColumn(),
  // Null until a chat binds to this user. A user is issued a binding code
  // before any chat has sent `/start`, so requiring the address here would mean
  // no user could ever be created to issue a code for. Still unique: Postgres
  // permits many nulls in a unique index but only one of any given chat id,
  // which is what makes one chat bind to at most one user.
  telegramChatId: text('telegram_chat_id').unique(),
  // Null until an address is known, for the same reason as the chat id above: a
  // user is seeded or invited before anyone has told us where to write to them.
  // Unique for the same reason too — Postgres permits many nulls in a unique
  // index but only one of any given address, and that is exactly the behaviour
  // magic-link auth needs: `POST /auth/request-link` resolves an address to at
  // most one account, so a link can never be issued into an ambiguity.
  email: text('email').unique(),
  tz: text('tz').notNull().default('UTC'),
  createdAt: timestampColumn('created_at').notNull().defaultNow(),
});

export const siteConnections = pgTable(
  'site_connections',
  {
    id: primaryKeyColumn(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    siteDomain: text('site_domain').notNull(),
    solariProfileId: text('solari_profile_id').notNull(),
    status: siteConnectionStatus('status').notNull().default('connected'),
    lastUsedAt: timestampColumn('last_used_at'),
  },
  // One reusable logged-in profile per site per user; re-linking updates it.
  (table) => [uniqueIndex('site_connections_user_domain_key').on(table.userId, table.siteDomain)],
);

export const watches = pgTable(
  'watches',
  {
    id: primaryKeyColumn(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: watchKind('kind').notNull(),
    url: text('url').notNull(),
    extractor: jsonb('extractor').notNull(),
    condition: jsonb('condition').notNull(),
    schedule: text('schedule').notNull(),
    tierPolicy: tierPolicy('tier_policy').notNull().default('auto'),
    status: watchStatus('status').notNull().default('active'),
    lastValue: jsonb('last_value'),
    lastCheckedAt: timestampColumn('last_checked_at'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  },
  (table) => [index('watches_user_id_idx').on(table.userId)],
);

export const observations = pgTable(
  'observations',
  {
    id: primaryKeyColumn(),
    watchId: uuid('watch_id')
      .notNull()
      .references(() => watches.id, { onDelete: 'cascade' }),
    checkedAt: timestampColumn('checked_at').notNull().defaultNow(),
    tierUsed: fetchTier('tier_used').notNull(),
    value: jsonb('value'),
    triggered: boolean('triggered').notNull().default(false),
    error: text('error'),
  },
  // Dashboard sparklines read the history of a single watch, newest first.
  (table) => [index('observations_watch_id_checked_at_idx').on(table.watchId, table.checkedAt)],
);

export const tasks = pgTable(
  'tasks',
  {
    id: primaryKeyColumn(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: taskKind('kind').notNull(),
    input: jsonb('input').notNull(),
    status: taskStatus('status').notNull().default('queued'),
    mode: taskMode('mode').notNull(),
    playbookId: text('playbook_id'),
    solariSessionId: text('solari_session_id'),
    recordingUrl: text('recording_url'),
    // Null until the task reaches a terminal transition, so a worker that
    // crashes mid-run leaves a resumable row rather than a half-written result.
    result: jsonb('result'),
    createdAt: timestampColumn('created_at').notNull().defaultNow(),
    finishedAt: timestampColumn('finished_at'),
  },
  (table) => [index('tasks_user_id_created_at_idx').on(table.userId, table.createdAt)],
);

export const taskEvents = pgTable(
  'task_events',
  {
    id: primaryKeyColumn(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    ts: timestampColumn('ts').notNull().defaultNow(),
    type: taskEventType('type').notNull(),
    payload: jsonb('payload').notNull(),
  },
  // The task timeline renders this index in order, and the pending ask_user
  // question is recovered by scanning the same key backwards after a restart.
  (table) => [index('task_events_task_id_ts_idx').on(table.taskId, table.ts)],
);

export const calendarItems = pgTable(
  'calendar_items',
  {
    id: primaryKeyColumn(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: calendarItemKind('kind').notNull(),
    name: text('name').notNull(),
    amountCents: integer('amount_cents'),
    renewOn: date('renew_on'),
    cancelBy: date('cancel_by'),
    action: jsonb('action'),
    status: calendarItemStatus('status').notNull().default('active'),
  },
  (table) => [index('calendar_items_user_id_idx').on(table.userId)],
);

export const messages = pgTable(
  'messages',
  {
    id: primaryKeyColumn(),
    // Null until the chat it arrived on is bound to a user. The bot transcribes
    // every message it handles, and the first thing an unbound stranger says
    // arrives before there is any user to attribute it to; refusing to store it
    // would leave the one exchange most worth reading — how someone failed to
    // bind — as the only one absent from the transcript.
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    // The channel-level address the row belongs to, which exists for every
    // message whether or not a user does. It is what an unattributed row is
    // read back by, and what binding later resolves.
    chatId: text('chat_id'),
    direction: messageDirection('direction').notNull(),
    channel: messageChannel('channel').notNull(),
    text: text('text').notNull(),
    // A transcript row outlives the task or watch it answered, so these links
    // clear rather than cascade.
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    watchId: uuid('watch_id').references(() => watches.id, { onDelete: 'set null' }),
    ts: timestampColumn('ts').notNull().defaultNow(),
  },
  (table) => [
    index('messages_user_id_ts_idx').on(table.userId, table.ts),
    index('messages_chat_id_ts_idx').on(table.chatId, table.ts),
  ],
);

/** Every table in the section 5 model, in dependency order. */
/**
 * One-time codes that bind a chat to a user (ARCHITECTURE §10). Not in the §5
 * sketch, which names the tables the product reads; this one is the mechanism
 * behind a line in §10, and it is a table rather than a signed token because
 * single use has to survive a restart and be revocable by deleting a row.
 */
export const bindingCodes = pgTable(
  'binding_codes',
  {
    id: primaryKeyColumn(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Unique so two users can never hold the same code, which would make
    // redemption ambiguous at exactly the moment it must not be.
    code: text('code').notNull().unique(),
    expiresAt: timestampColumn('expires_at').notNull(),
    // Set when redeemed, and the whole of single-use: a code is spent, not
    // deleted, so a second attempt can be told apart from a code that never
    // existed and answered differently.
    consumedAt: timestampColumn('consumed_at'),
    createdAt: timestampColumn('created_at').notNull().defaultNow(),
  },
  (table) => [index('binding_codes_user_id_idx').on(table.userId)],
);

/**
 * One magic link, from the moment it is issued to the moment it is spent.
 *
 * Deliberately shaped like `bindingCodes` above, because it is the same problem
 * one channel over: a single-use credential that has to survive a restart and
 * be revocable by deleting a row. The one difference is what is stored.
 *
 * `bindingCodes` stores the code itself — it is six characters a person reads
 * off a screen and types, and it is worthless without also knowing the chat to
 * type it into. A magic-link token is the whole credential: anything holding it
 * is that user. So only a one-way digest of it is stored, and the token itself
 * exists nowhere but in the link that was mailed. A database that leaks cannot
 * be used to mint a working link, and a tampered token simply digests to
 * something no row carries.
 */
export const loginTokens = pgTable(
  'login_tokens',
  {
    id: primaryKeyColumn(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Unique so two links can never digest to the same row, which would make
    // consumption ambiguous at exactly the moment it must not be.
    tokenDigest: text('token_digest').notNull().unique(),
    expiresAt: timestampColumn('expires_at').notNull(),
    // Set when the link is followed, and the whole of single use: a token is
    // spent, not deleted, so a second visit can be told apart from a link that
    // never existed. Consumption is one UPDATE that filters on this being null,
    // so two concurrent visits race in the database and exactly one wins.
    consumedAt: timestampColumn('consumed_at'),
    createdAt: timestampColumn('created_at').notNull().defaultNow(),
  },
  (table) => [index('login_tokens_user_id_idx').on(table.userId)],
);

/**
 * One attempt to put a message in a user's chat, and what became of it.
 *
 * Deliberately not the same row as the transcript. `messages` is what the user
 * was told, and a send that failed was not told to anybody; this is what the
 * system tried to do and whether it worked, which is the question a reminder in
 * s7 or a red-run alert in s9 needs answered when nothing arrived. The row is
 * written `pending` before the send and settled afterwards, so a process killed
 * mid-send leaves evidence that a message was owed.
 */
export const deliveries = pgTable(
  'deliveries',
  {
    id: primaryKeyColumn(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // The address at the time of sending, stored rather than resolved. A user
    // who later moves to another chat must not make an old delivery read as
    // though it went somewhere it did not.
    chatId: text('chat_id').notNull(),
    text: text('text').notNull(),
    status: deliveryStatus('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    // The last thing the send was told, kept only when it failed - a successful
    // delivery that retried once has nothing left to explain.
    error: text('error'),
    createdAt: timestampColumn('created_at').notNull().defaultNow(),
    // Null exactly while the delivery is still pending, which is what makes a
    // stuck row findable without joining anything.
    settledAt: timestampColumn('settled_at'),
  },
  (table) => [index('deliveries_user_id_created_at_idx').on(table.userId, table.createdAt)],
);

export const SCHEMA_TABLE_NAMES = [
  'users',
  'site_connections',
  'watches',
  'observations',
  'tasks',
  'task_events',
  'calendar_items',
  'messages',
  'binding_codes',
  'login_tokens',
  'deliveries',
] as const;

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type SiteConnection = typeof siteConnections.$inferSelect;
export type NewSiteConnection = typeof siteConnections.$inferInsert;
export type Watch = typeof watches.$inferSelect;
export type NewWatch = typeof watches.$inferInsert;
export type Observation = typeof observations.$inferSelect;
export type NewObservation = typeof observations.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type TaskEvent = typeof taskEvents.$inferSelect;
export type NewTaskEvent = typeof taskEvents.$inferInsert;
export type CalendarItem = typeof calendarItems.$inferSelect;
export type NewCalendarItem = typeof calendarItems.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type BindingCode = typeof bindingCodes.$inferSelect;
export type NewBindingCode = typeof bindingCodes.$inferInsert;
export type LoginToken = typeof loginTokens.$inferSelect;
export type NewLoginToken = typeof loginTokens.$inferInsert;
export type Delivery = typeof deliveries.$inferSelect;
export type NewDelivery = typeof deliveries.$inferInsert;
