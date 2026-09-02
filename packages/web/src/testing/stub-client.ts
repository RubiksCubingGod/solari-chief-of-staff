import type { ApiClient } from '../api-client';

/**
 * An API client whose every method fails until a test says what it answers.
 *
 * A loader test is about one or two calls, and the rest of the client is not
 * "unused" - it is a call the loader must not make. A stub of empty resolvers
 * would let a page fetch the whole API and still pass; this one turns any
 * unasked-for call into a failure that names the method, so a loader that
 * quietly grew a dependency says so.
 *
 * Listed once here rather than in each test file, so adding a method to
 * `ApiClient` breaks one place instead of every loader's tests.
 */
export function stubClient(overrides: Partial<ApiClient>): ApiClient {
  return {
    health: unexpected('health'),
    session: unexpected('session'),
    requestLink: unexpected('requestLink'),
    listWatches: unexpected('listWatches'),
    listObservations: unexpected('listObservations'),
    setWatchStatus: unexpected('setWatchStatus'),
    listCalendarItems: unexpected('listCalendarItems'),
    listTasks: unexpected('listTasks'),
    getTask: unexpected('getTask'),
    readTaskRecording: unexpected('readTaskRecording'),
    ...overrides,
  };
}

const unexpected =
  (name: string) =>
  (): Promise<never> =>
    Promise.reject(new Error(`${name} was not expected in this test`));
