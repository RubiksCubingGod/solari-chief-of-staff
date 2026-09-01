import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import next from 'next';

import { API_BASE_URL_VARIABLE } from '../config';
import { withEnvironmentVariable } from './environment';

/** The app root, resolved from this file so no test has to know where it is. */
const APPLICATION_DIRECTORY = fileURLToPath(new URL('../..', import.meta.url));
const HOST = '127.0.0.1';

/**
 * A Next dev server owned by exactly one test file.
 */
export interface WebDevServer {
  readonly url: string;
  stop(): Promise<void>;
}

export interface StartWebDevServerOptions {
  /** What the app should be configured to treat as the API's origin. */
  readonly apiBaseUrl: string;
  /**
   * A port to bind, instead of whichever one is free.
   *
   * Only needed when something else has to be told where the dashboard is
   * before it starts. The auth flow is exactly that case: the API builds its
   * redirects out of a configured dashboard origin, so one of the two servers
   * has to have a known address first, and a test reserves this one for it.
   */
  readonly port?: number | undefined;
}

/**
 * Boots the dashboard in this process on an ephemeral loopback port, the way
 * `fixtures/src/harness.ts` boots a fixture site: the instance belongs to one
 * test file, two files cannot collide on a port or on a build directory, and
 * `stop()` is the only thing that has to be honest for whatever runs next to
 * start cleanly.
 *
 * In process rather than as a child of `next dev`, because a child process on
 * Windows is a process tree that has to be killed by name rather than by
 * handle - and a teardown that can leak a server is not a teardown.
 */
export async function startWebDevServer(
  options: StartWebDevServerOptions,
): Promise<WebDevServer> {
  // Next reads its configuration the way a deployed app does, from the process
  // environment, so an in-process server has to be handed it there.
  const restoreEnvironment = withEnvironmentVariable(
    API_BASE_URL_VARIABLE,
    options.apiBaseUrl,
  );

  // Bound before the app is prepared so the port Next is told about is the port
  // it is actually reachable on. Nothing dials it until this function returns,
  // so there is no window in which a request arrives unhandled.
  const server = createServer();
  await listen(server, HOST, options.port ?? 0);
  const { port } = server.address() as AddressInfo;
  const url = `http://${HOST}:${String(port)}`;

  // Next 16 takes an exclusive lock at `<distDir>/lock` and refuses to start a
  // second dev server that would share it, so the build directory is per
  // instance rather than the default one every instance would contend on.
  // Without this, two test files booting a dashboard in parallel is not a race
  // that sometimes passes: the loser calls `process.exit(1)` on the spot.
  const buildDirectory = `.next/instance-${randomUUID()}`;

  const app = next({
    dev: true,
    dir: APPLICATION_DIRECTORY,
    hostname: HOST,
    port,
    conf: { distDir: buildDirectory },
  });
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    restoreEnvironment();
    // Keep-alive sockets from fetch outlive the response; without this the
    // close callback never fires and the port stays bound.
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await app.close();
    // The directory is inside the gitignored `.next`, so a leftover is harmless
    // to the repository - but a suite that boots a dashboard per test would
    // otherwise grow one per instance forever. Best effort on purpose: a build
    // artefact Windows still holds a handle to is not worth failing a teardown
    // over.
    try {
      await rm(join(APPLICATION_DIRECTORY, buildDirectory), { recursive: true, force: true });
    } catch {
      // Ignored deliberately; see above.
    }
  };

  try {
    await app.prepare();
  } catch (error: unknown) {
    // A compile failure during boot must not leave the port bound and the
    // environment rewritten behind it.
    await stop();
    throw error;
  }

  const handle = app.getRequestHandler();
  server.on('request', (request, response) => {
    void handle(request, response);
  });

  return { url, stop };
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}
