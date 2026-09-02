/**
 * Domain vocabulary from ARCHITECTURE §5 and §3.2.
 *
 * Every layer that has to name a watch kind, a task status, or a task event
 * type reads it from here, so the API schemas, the Drizzle enums, and the bot
 * never drift into three slightly different spellings of the same list.
 */

export const WATCH_KINDS = ['price', 'slot', 'change'] as const;
export type WatchKind = (typeof WATCH_KINDS)[number];

export const TASK_KINDS = ['cancel', 'book_slot', 'custom'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/**
 * The persisted state machine from ARCHITECTURE §3.2. `cancelled` is the end a
 * task reaches when the person it asked says no; the moves between these live
 * in `task-lifecycle.ts`.
 */
export const TASK_STATUSES = [
  'queued',
  'running',
  'waiting_user',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_MODES = ['playbook', 'agentic'] as const;
export type TaskMode = (typeof TASK_MODES)[number];

/**
 * What a `task_events` row records. `rejected` is a move the machine refused:
 * it changes nothing on the task and exists so the attempt is on the record.
 */
export const TASK_EVENT_TYPES = ['step', 'ask_user', 'user_reply', 'transition', 'rejected'] as const;
export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];

export const CALENDAR_ITEM_KINDS = ['subscription', 'deadline'] as const;
export type CalendarItemKind = (typeof CALENDAR_ITEM_KINDS)[number];

export const WATCH_STATUSES = ['active', 'paused'] as const;
export type WatchStatus = (typeof WATCH_STATUSES)[number];

/**
 * How the engine is doing at a watch, as distinct from whether the person
 * wants it running (`WatchStatus`). `healthy` is the ordinary case;
 * `needs_extractor` is a watch the model could not write an extractor for;
 * `blocked` is one every fetch tier was refused at; `degraded` is one whose
 * extractor stopped matching and could not be healed. Each of the last three
 * is what a check found, and only the engine or a reset moves a watch out.
 */
export const WATCH_HEALTH_STATES = ['healthy', 'needs_extractor', 'blocked', 'degraded'] as const;
export type WatchHealth = (typeof WATCH_HEALTH_STATES)[number];

/** The fetch tier ladder from ARCHITECTURE §3.1, cheapest tier first. */
export const FETCH_TIERS = ['http', 'browser', 'stealth'] as const;
export type FetchTier = (typeof FETCH_TIERS)[number];

/**
 * How far up the tier ladder a watch may climb. `auto` escalates on a block
 * signal; every other policy pins a single tier.
 */
export const TIER_POLICIES = ['auto', ...FETCH_TIERS] as const;
export type TierPolicy = (typeof TIER_POLICIES)[number];

export const SITE_CONNECTION_STATUSES = ['connected', 'expired'] as const;
export type SiteConnectionStatus = (typeof SITE_CONNECTION_STATUSES)[number];

export const CALENDAR_ITEM_STATUSES = ['active', 'done'] as const;
export type CalendarItemStatus = (typeof CALENDAR_ITEM_STATUSES)[number];

export const MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const MESSAGE_CHANNELS = ['telegram'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

/**
 * The life of one outbound notification. `pending` is written before the send
 * is attempted, so a process that dies mid-send leaves a row that says a
 * message was owed rather than leaving no trace of it at all.
 */
export const DELIVERY_STATUSES = ['pending', 'sent', 'failed'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * Builds a type guard over a closed string list. Used instead of hand-written
 * guards so adding a member to a list cannot leave a stale guard behind.
 */
export function memberGuard<T extends string>(
  values: readonly T[],
): (value: unknown) => value is T {
  const allowed: ReadonlySet<string> = new Set(values);
  return (value: unknown): value is T => typeof value === 'string' && allowed.has(value);
}

export const isWatchKind = memberGuard(WATCH_KINDS);
export const isTaskKind = memberGuard(TASK_KINDS);
export const isTaskStatus = memberGuard(TASK_STATUSES);
export const isTaskMode = memberGuard(TASK_MODES);
export const isTaskEventType = memberGuard(TASK_EVENT_TYPES);
export const isCalendarItemKind = memberGuard(CALENDAR_ITEM_KINDS);
export const isWatchStatus = memberGuard(WATCH_STATUSES);
export const isWatchHealth = memberGuard(WATCH_HEALTH_STATES);
export const isFetchTier = memberGuard(FETCH_TIERS);
export const isTierPolicy = memberGuard(TIER_POLICIES);
export const isSiteConnectionStatus = memberGuard(SITE_CONNECTION_STATUSES);
export const isCalendarItemStatus = memberGuard(CALENDAR_ITEM_STATUSES);
export const isMessageDirection = memberGuard(MESSAGE_DIRECTIONS);
export const isMessageChannel = memberGuard(MESSAGE_CHANNELS);
export const isDeliveryStatus = memberGuard(DELIVERY_STATUSES);

export {
  BINDING_CODE_ALPHABET,
  BINDING_CODE_LENGTH,
  isBindingCode,
  normalizeBindingCode,
} from './binding-code.js';

export * from './task-lifecycle.js';
export * from './user-io.js';
export * from './watch/index.js';
