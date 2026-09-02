import type { TaskEventType, TaskKind, TaskMode, TaskStatus } from '@chief-of-staff/core';

import { ApiError, type ApiClient, type TaskDetail, type TaskEvent } from '../api-client';
import { describeRefusal } from '../api-refusal';

/**
 * Everything the task detail page draws, worked out before any of it is drawn.
 *
 * The trail is the trust surface: every consequential thing the engine did to
 * a task is an event, and this page's job is to tell them in order, in words,
 * without losing the ones it does not recognise. Each event becomes a headline
 * built from the payload shape core declares for its type; an event whose
 * payload is not that shape is shown as itself rather than dropped, because a
 * trail with a hole in it is the one thing this page exists to prevent.
 */

export interface TimelineEntry {
  readonly seq: number;
  readonly ts: string;
  readonly type: TaskEventType;
  readonly headline: string;
  readonly detail: string | undefined;
}

export interface PendingQuestion {
  readonly question: string;
  readonly askedAt: string;
  readonly expiresAt: string | undefined;
}

export interface TaskDetailView {
  readonly id: string;
  readonly kind: TaskKind;
  readonly status: TaskStatus;
  readonly mode: TaskMode;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  /** Oldest first: the order it happened. */
  readonly timeline: readonly TimelineEntry[];
  /** The question the task is parked on, when it is parked on one. */
  readonly pendingQuestion: PendingQuestion | undefined;
  /** Where this dashboard serves the recording from, when there is one. */
  readonly recordingHref: string | undefined;
}

export type TaskDetailOutcome =
  | { readonly kind: 'found'; readonly view: TaskDetailView }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly error: string };

export async function loadTaskDetail(client: ApiClient, id: string): Promise<TaskDetailOutcome> {
  let task: TaskDetail;
  try {
    task = await client.getTask(id);
  } catch (error: unknown) {
    // A stranger's task and a task that never existed are the same 404 from
    // the API, and become the same page here: not found, never "not yours".
    if (error instanceof ApiError && error.status === 404) return { kind: 'missing' };
    return { kind: 'failed', error: describeRefusal(error) };
  }
  return { kind: 'found', view: toView(task) };
}

export function toView(task: TaskDetail): TaskDetailView {
  // The API already orders by sequence; sorting again costs nothing and makes
  // the order this page shows a property of this page.
  const events = [...task.events].sort((a, b) => a.seq - b.seq);
  return {
    id: task.id,
    kind: task.kind,
    status: task.status,
    mode: task.mode,
    createdAt: task.createdAt,
    finishedAt: task.finishedAt,
    timeline: events.map(describeEvent),
    pendingQuestion: task.status === 'waiting_user' ? openQuestion(events) : undefined,
    // The dashboard's own route rather than the API's: same origin, the
    // browser's own cookie, and the store never named to the page.
    recordingHref: task.recording.available
      ? `/tasks/${encodeURIComponent(task.id)}/recording`
      : undefined,
  };
}

/** One event as a headline and, where the payload carries one, a detail line. */
export function describeEvent(event: TaskEvent): TimelineEntry {
  const fields = record(event.payload);
  const entry = { seq: event.seq, ts: event.ts, type: event.type };
  switch (event.type) {
    case 'transition': {
      const from = text(fields['from']);
      const to = text(fields['to']);
      const cause = text(fields['cause']);
      if (from === undefined || to === undefined) break;
      return {
        ...entry,
        headline: cause === undefined ? `${from} → ${to}` : `${from} → ${to} (${cause})`,
        detail: describeDetail(fields['detail']),
      };
    }
    case 'step': {
      const name = text(fields['name']);
      if (name === undefined) break;
      const outcome = text(fields['outcome']);
      return {
        ...entry,
        headline: outcome === undefined ? name : `${name}: ${outcome}`,
        detail: describeDetail(fields['detail']),
      };
    }
    case 'ask_user': {
      const question = text(fields['question']);
      if (question === undefined) break;
      const expiresAt = text(fields['expiresAt']);
      return {
        ...entry,
        headline: `Asked: ${question}`,
        detail: expiresAt === undefined ? undefined : `answer wanted by ${expiresAt}`,
      };
    }
    case 'user_reply': {
      const reply = text(fields['reply']);
      if (reply === undefined) break;
      return { ...entry, headline: `Replied: ${reply}`, detail: undefined };
    }
    case 'rejected': {
      const attempted = text(fields['attempted']);
      const status = text(fields['status']);
      const reason = text(fields['reason']);
      if (attempted === undefined || status === undefined || reason === undefined) break;
      return {
        ...entry,
        headline: `Refused ${attempted} while ${status}: ${reason}`,
        detail: describeDetail(fields['detail']),
      };
    }
  }
  // Not the shape core declares for this type: shown as itself, not dropped.
  return { ...entry, headline: event.type, detail: describeDetail(event.payload) };
}

/** The last question asked that no reply has answered. */
function openQuestion(events: readonly TaskEvent[]): PendingQuestion | undefined {
  let open: PendingQuestion | undefined;
  for (const event of events) {
    const fields = record(event.payload);
    if (event.type === 'ask_user') {
      const question = text(fields['question']);
      if (question !== undefined) {
        open = {
          question,
          askedAt: text(fields['askedAt']) ?? event.ts,
          expiresAt: text(fields['expiresAt']),
        };
      }
    } else if (event.type === 'user_reply') {
      open = undefined;
    }
  }
  return open;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A detail on one line: text as itself, anything else as JSON, nothing for nothing. */
function describeDetail(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}
