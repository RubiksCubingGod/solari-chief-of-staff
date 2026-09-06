import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startWebDevServer, type WebDevServer } from './testing/dev-server';

/**
 * What a dashboard instance must leave behind when it is stopped: nothing, and
 * nothing still running.
 *
 * Every other integration file here boots one of these and trusts `stop()`.
 * This is the file that does not - because the thing `stop()` was getting wrong
 * did not fail any of them. It removed the build directory while Turbopack's
 * persisting thread was still writing into it, and that thread is native and is
 * not joined by `app.close()`, so the failure arrived after the test that
 * caused it had already passed:
 *
 *     Persisting failed: Unable to write SST file 00000025.sst
 *     Persisting is disabled for this session due to an unrecoverable error.
 *     thread '<unnamed>' panicked at turbo-tasks-backend: Failed to restore
 *       data for task TaskId 135
 *
 * "This session" is the whole process, so the cost lands on whichever files the
 * runner scheduled next in that worker, and the panic is a thread that can take
 * a passing run down with it. Asserted here as the absence of the cache rather
 * than the absence of the stderr, because a message printed by a native thread
 * some time after teardown is exactly the kind of evidence that is not there
 * yet when you look for it.
 *
 * One server, one assertion pass, because Next will not give this process a
 * second one: `next()` registers a Turbopack worker creator per process, and a
 * second instance in the same worker rejects with `Worker creator already
 * registered` before it can bind. Every integration file here boots exactly one
 * dashboard, which is why that has never come up anywhere but in this test.
 *
 * A cache is what a later run reads. These directories are per instance and
 * named with a fresh uuid, so there is no later run that could: every byte
 * written there is written to be deleted, and the race is over work that had no
 * reader in the first place.
 */

/**
 * Nothing is dialled through the app, so this only has to be somewhere the
 * dashboard will not reach. Port 1 is reserved and never listening.
 */
const UNUSED_API = 'http://127.0.0.1:1';

let running: WebDevServer | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

describe('the in-process dashboard', () => {
  it(
    'compiles a page without opening a cache nothing will ever read, and takes its build directory with it',
    async () => {
      const web = await startWebDevServer({ apiBaseUrl: UNUSED_API });
      running = web;

      // Something has to be compiled or there is nothing for Turbopack to have
      // persisted. `/login` is the one page that draws without the API.
      const response = await fetch(`${web.url}/login`);
      expect(response.status).toBe(200);
      await response.text();
      expect(existsSync(web.buildDirectory)).toBe(true);

      const cache = join(web.buildDirectory, 'dev', 'cache', 'turbopack');
      // Where the SST files go. Its absence is the whole property: no cache, no
      // persisting thread, and so nothing still writing into a directory that
      // teardown is about to remove.
      expect(existsSync(cache), `Turbopack is persisting into ${cache}`).toBe(false);

      await web.stop();
      running = undefined;

      // And gone afterwards. A suite that boots one of these per file would
      // otherwise grow a directory per instance forever, each holding a compile
      // of the whole app.
      expect(existsSync(web.buildDirectory), `${web.buildDirectory} outlived stop()`).toBe(
        false,
      );
    },
    300_000,
  );
});
