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

/** The persisted state machine from ARCHITECTURE §3.2. */
export const TASK_STATUSES = [
  'queued',
  'running',
  'waiting_user',
  'succeeded',
  'failed',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_MODES = ['playbook', 'agentic'] as const;
export type TaskMode = (typeof TASK_MODES)[number];

export const TASK_EVENT_TYPES = ['step', 'ask_user', 'user_reply', 'transition'] as const;
export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];

export const CALENDAR_ITEM_KINDS = ['subscription', 'deadline'] as const;
export type CalendarItemKind = (typeof CALENDAR_ITEM_KINDS)[number];

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
