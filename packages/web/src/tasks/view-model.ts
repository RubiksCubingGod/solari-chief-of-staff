import type { TaskKind, TaskStatus } from '@chief-of-staff/core';

import type { ApiClient, Task } from '../api-client';
import { describeRefusal } from '../api-refusal';

/**
 * Everything the task history page draws, worked out before any of it is drawn.
 *
 * A shell rather than a surface: s5 builds the run detail, and what this task
 * owes it is the list that links there. So the interesting decisions here are
 * small and worth pinning anyway - what a task row is called before anybody has
 * named it, and where its detail will live - because both are contracts the
 * next sprint reads rather than choices it is free to change.
 */

/** One task as the page prints it. */
export interface TaskRow {
  readonly id: string;
  readonly kind: TaskKind;
  readonly status: TaskStatus;
  /** When it was created, ISO, exactly as the API said it. */
  readonly createdAt: string;
  /**
   * Where this run's detail lives. It is a real path rather than a disabled
   * button, because the slot s5 fills is part of what this shell is for: the
   * link is the reservation.
   */
  readonly href: string;
}

export interface TasksView {
  readonly rows: readonly TaskRow[];
  /** What went wrong, when the page has nothing to draw because of it. */
  readonly error: string | undefined;
}

export async function loadTasksView(client: ApiClient): Promise<TasksView> {
  let tasks: readonly Task[];
  try {
    tasks = await client.listTasks();
  } catch (error: unknown) {
    return { rows: [], error: describeRefusal(error) };
  }

  // Listed in the order the API gave. `GET /tasks` orders by `created_at`
  // descending and breaks ties on id, which is a stronger order than this page
  // could rebuild from the fields it is handed: two runs created in the same
  // millisecond are indistinguishable here. Sorting again would be this page
  // pretending to know better while actually knowing less.
  return { rows: tasks.map(toRow), error: undefined };
}

function toRow(task: Task): TaskRow {
  return {
    id: task.id,
    kind: task.kind,
    status: task.status,
    createdAt: task.createdAt,
    // Escaped, because an id is not a path segment until it has been made into
    // one. Ids are uuids today, which is a fact about the database's current
    // default and not a promise to this page.
    href: `/tasks/${encodeURIComponent(task.id)}`,
  };
}
