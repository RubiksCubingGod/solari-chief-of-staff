import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { startTestPostgres, type TestPostgres } from '@chief-of-staff/db/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * `pnpm start` and `pnpm worker` are the two commands the README tells a
 * deployment to run, so they are proven by running them: a real process, a real
 * socket, a real shutdown. Reading the scripts would prove only that they parse.
 */

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

let postgres: TestPostgres;
const running: ChildProcess[] = [];

beforeAll(async () => {
  postgres = await startTestPostgres();
});

afterEach(() => {
  for (const child of running.splice(0)) {
    if (child.exitCode === null) child.kill();
  }
});

afterAll(async () => {
  await postgres.stop();
});

/** An OS-assigned port, so a test cannot collide with a running server. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    probe.close(() => resolve());
  });
  return port;
}

function launch(script: string, extra: NodeJS.ProcessEnv = {}): ChildProcess {
  const child = spawn(process.execPath, [script], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      DATABASE_URL: postgres.connectionString,
      LOG_LEVEL: 'silent',
      NODE_ENV: 'test',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);
  return child;
}

/**
 * Resolves with the first output the process writes that matches, so a test
 * waits for the process to say it is up rather than for a fixed delay.
 */
function announced(child: ChildProcess, pattern: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const read = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      const match = pattern.exec(output);
      if (match !== null) resolve(match[0]);
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    child.once('error', reject);
    child.once('exit', (code) => {
      reject(
        new Error(
          `the process exited with ${String(code)} before writing ${pattern.source}:\n${output}`,
        ),
      );
    });
  });
}

function exitOf(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
}

/**
 * Windows has no SIGTERM to deliver: `kill('SIGTERM')` terminates the process
 * outright, so a handler could never run and the assertion would say nothing
 * about the code. CI runs on Linux, where it is a real signal.
 */
const signalsAreDeliverable = process.platform !== 'win32';

describe('pnpm start', () => {
  it(
    'binds the configured port and serves /health there',
    async () => {
      const port = await freePort();
      const server = launch('scripts/server.mjs', { HOST: '127.0.0.1', PORT: String(port) });

      const address = await announced(server, /http:\/\/127\.0\.0\.1:\d+/u);
      expect(address).toBe(`http://127.0.0.1:${String(port)}`);

      const response = await fetch(`${address}/health`);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });
    },
    180_000,
  );

  it.skipIf(!signalsAreDeliverable)(
    'shuts down on SIGTERM instead of being killed',
    async () => {
      const server = launch('scripts/server.mjs', {
        HOST: '127.0.0.1',
        PORT: String(await freePort()),
      });
      await announced(server, /http:\/\/127\.0\.0\.1:\d+/u);

      server.kill('SIGTERM');

      expect(await exitOf(server)).toBe(0);
    },
    180_000,
  );
});

describe('pnpm worker', () => {
  it(
    'starts the job harness and says so',
    async () => {
      const worker = launch('scripts/worker.mjs');

      expect(await announced(worker, /worker: ready/u)).toBe('worker: ready');
    },
    180_000,
  );

  it.skipIf(!signalsAreDeliverable)(
    'shuts down on SIGTERM instead of being killed',
    async () => {
      const worker = launch('scripts/worker.mjs');
      await announced(worker, /worker: ready/u);

      worker.kill('SIGTERM');

      expect(await exitOf(worker)).toBe(0);
    },
    180_000,
  );
});
