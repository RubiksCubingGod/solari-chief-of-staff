import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express, { type Express } from 'express';

/**
 * Raised when a control-plane call is made against an instance that has
 * already stopped. A typed error rather than a hanging fetch: a test that
 * asserts after teardown should fail immediately and say why.
 */
export class FixtureStoppedError extends Error {
  constructor(name: string) {
    super(`fixture "${name}" is stopped; its control plane is no longer reachable`);
    this.name = 'FixtureStoppedError';
  }
}

/**
 * Issues one control-plane request against the instance that produced it.
 * Every fixture's typed control client is built on top of this, so the
 * stopped-instance guard exists in exactly one place.
 */
/**
 * Reads a parsed JSON request body as a plain record so a control-plane route
 * can validate named fields without reaching through `any`. A non-object body
 * becomes an empty record, which every validator then rejects by field.
 */
export function readRecord(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}

export type ControlRequest = <TResult>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
) => Promise<TResult>;

/**
 * A running fixture owned by exactly one test file.
 */
export interface FixtureHandle<TControl> {
  readonly name: string;
  readonly url: string;
  readonly control: TControl;
  stop(): Promise<void>;
}

export interface StartFixtureOptions {
  /**
   * Bind to a specific port instead of an ephemeral one. Only the harness's
   * own port-release proof needs this; fixtures always take port 0 so that
   * concurrent test files cannot collide.
   */
  readonly port?: number;
}

const live = new Map<object, string>();

/**
 * How many fixtures this worker still has running. Vitest runs each test file
 * in its own worker process, so this counts one file's instances and nothing
 * else.
 */
export function liveFixtureCount(): number {
  return live.size;
}

/**
 * Fails when any fixture is still running. Registered as an `afterEach` by the
 * fixture tests themselves so a forgotten teardown surfaces at its own test
 * rather than as a mystery hang or a cross-test state leak later on.
 */
export function assertNoLeakedFixtures(): void {
  if (live.size === 0) {
    return;
  }
  const names = [...live.values()].sort().join(', ');
  live.clear();
  throw new Error(`fixture instances were left running: ${names}`);
}

/**
 * Boots one fixture in this process on a loopback port.
 *
 * Isolation is a property of this boot model, not of a reset call: state lives
 * in the closure `mount` builds, so two instances - in one file or across
 * parallel workers - cannot observe each other.
 */
export async function startFixture<TControl>(
  name: string,
  mount: (app: Express) => void,
  buildControl: (request: ControlRequest) => TControl,
  options: StartFixtureOptions = {},
): Promise<FixtureHandle<TControl>> {
  const app = express();
  app.use(express.json());
  mount(app);

  const server = createServer(app);
  await listen(server, options.port ?? 0);

  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const token = {};
  live.set(token, name);

  let stopped = false;

  const request: ControlRequest = async <TResult>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<TResult> => {
    if (stopped) {
      throw new FixtureStoppedError(name);
    }
    const response = await fetch(`${url}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    });
    if (!response.ok) {
      throw new Error(
        `fixture "${name}" refused ${method} ${path}: ${response.status} ${await response.text()}`,
      );
    }
    return (await response.json()) as TResult;
  };

  return {
    name,
    url,
    control: buildControl(request),
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      live.delete(token);
      // Keep-alive sockets from fetch outlive the request; without this the
      // close callback never fires and the port stays bound.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}
