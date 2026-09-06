import { describe, expect, it } from 'vitest';

import { ApiError, ApiUnreachableError, type Task } from '../api-client';
import { stubClient } from '../testing/stub-client';
import { loadTasksView } from './view-model';

/**
 * What the task history does with what it is handed, proven directly.
 *
 * Less to decide than the calendar has, and the two decisions it does make are
 * worth pinning because s5 reads them as contracts: the order runs are listed
 * in, and where a run's detail lives.
 */

function task(overrides: Partial<Task> & { readonly id: string }): Task {
  return {
    userId: 'user-1',
    kind: 'cancel',
    input: { note: 'cancel something' },
    status: 'queued',
    mode: 'playbook',
    playbookId: null,
    solariSessionId: null,
    recordingUrl: null,
    result: null,
    llmUsage: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

describe('loadTasksView', () => {
  it('keeps the order the API gave, which is the newest run first', async () => {
    const view = await loadTasksView(
      stubClient({
        listTasks: () =>
          Promise.resolve([
            task({ id: 'newest', createdAt: '2026-01-03T00:00:00.000Z' }),
            task({ id: 'middle', createdAt: '2026-01-02T00:00:00.000Z' }),
            task({ id: 'oldest', createdAt: '2026-01-01T00:00:00.000Z' }),
          ]),
      }),
    );

    // Deliberately not re-sorted here. `GET /tasks` orders by `created_at`
    // descending and breaks ties on id, which is a stronger order than this
    // page could reconstruct from the fields it is given - two runs created in
    // the same millisecond are indistinguishable by the time they arrive. A
    // second sort would be this page pretending to know better while actually
    // knowing less.
    expect(view.rows.map((row) => row.id)).toEqual(['newest', 'middle', 'oldest']);
    expect(view.error).toBeUndefined();
  });

  it('carries each run to its own detail page', async () => {
    const view = await loadTasksView(
      stubClient({ listTasks: () => Promise.resolve([task({ id: 'run-1', kind: 'book_slot' })]) }),
    );

    // The slot s5 fills. A shell whose links all went to the same place would
    // look finished and be useless.
    expect(view.rows[0]).toMatchObject({
      id: 'run-1',
      kind: 'book_slot',
      href: '/tasks/run-1',
    });
  });

  it('escapes an id rather than letting it choose the path', async () => {
    const view = await loadTasksView(
      stubClient({ listTasks: () => Promise.resolve([task({ id: 'a/b' })]) }),
    );

    // Ids are uuids today. That is a fact about the database's current default
    // and not a promise to this page, and an id is not a path segment until it
    // has been made into one.
    expect(view.rows[0]?.href).toBe('/tasks/a%2Fb');
  });

  it('shows every run, including the ones that are still going', async () => {
    const view = await loadTasksView(
      stubClient({
        listTasks: () =>
          Promise.resolve([
            task({ id: 'running', status: 'running' }),
            task({ id: 'asking', status: 'waiting_user' }),
            task({ id: 'failed', status: 'failed' }),
          ]),
      }),
    );

    // A history that only listed finished runs would be missing the one a
    // reader is most likely looking for: the one that is stuck waiting on them.
    expect(view.rows.map((row) => row.status)).toEqual(['running', 'waiting_user', 'failed']);
  });

  it('turns a refusal into the page state, with the reason the API gave', async () => {
    const view = await loadTasksView(
      stubClient({
        listTasks: () =>
          Promise.reject(new ApiError(403, 'forbidden', 'this account may not read tasks', [])),
      }),
    );

    expect(view.rows).toEqual([]);
    expect(view.error).toBe('this account may not read tasks');
  });

  it('says the API did not answer when it did not answer', async () => {
    const view = await loadTasksView(
      stubClient({
        listTasks: () =>
          Promise.reject(new ApiUnreachableError('https://api.example.com', new Error('ECONNREFUSED'))),
      }),
    );

    expect(view.rows).toEqual([]);
    expect(view.error).toBe('the API did not answer');
  });

  it('lets a defect in this process through rather than dressing it as a page state', async () => {
    await expect(
      loadTasksView(stubClient({ listTasks: () => Promise.reject(new TypeError('not a function')) })),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
