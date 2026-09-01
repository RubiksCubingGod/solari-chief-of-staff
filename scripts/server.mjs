#!/usr/bin/env node
// Runs the API server on HOST and PORT. Documented as `pnpm start`.
//
// The process is TypeScript, so this builds the api package before
// importing it, for the same reason `pnpm migrate` does: a documented command
// has to work from a fresh clone without anyone knowing to build first. The
// build is incremental, so repeat runs are almost free.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { shutdownOn } from './shutdown.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

const build = spawn(
  process.execPath,
  ['node_modules/typescript/bin/tsc', '--build', 'packages/api'],
  { cwd: repositoryRoot, shell: false, stdio: 'inherit' },
);

build.once('error', (error) => {
  process.stderr.write(`server: could not build the api package: ${error.message}\n`);
  process.exit(1);
});

build.once('close', (code) => {
  if (code !== 0) {
    process.stderr.write('server: the api package did not build\n');
    process.exit(code ?? 1);
  }
  void run();
});

async function run() {
  const { startServer } = await import('../packages/api/dist/index.js');
  let server;
  try {
    server = await startServer();
  } catch (error) {
    process.stderr.write(`server: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
    return;
  }
  process.stdout.write(`server: listening on ${server.url}\n`);
  shutdownOn(['SIGTERM', 'SIGINT'], async () => {
    await server.stop();
    process.stdout.write('server: stopped\n');
  });
}
