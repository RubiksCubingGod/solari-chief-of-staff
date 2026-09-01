import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
}

/**
 * Boots the dashboard in this process on an ephemeral loopback port, the way
 * `fixtures/src/harness.ts` boots a fixture site: the instance belongs to one
 * test file, two files cannot collide on a port, and `stop()` is the only thing
 * that has to be honest for whatever runs next to start cleanly.
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
  await listen(server, HOST);
  const { port } = server.address() as AddressInfo;
  const url = `http://${HOST}:${String(port)}`;

  const app = next({ dev: true, dir: APPLICATION_DIRECTORY, hostname: HOST, port });
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

function listen(server: Server, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}
