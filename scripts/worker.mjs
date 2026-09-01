#!/usr/bin/env node
// Runs the job worker pool against DATABASE_URL. Documented as `pnpm worker`.
//
// The process is TypeScript, so this builds the db package before
// importing it, for the same reason `pnpm migrate` does: a documented command
// has to work from a fresh clone without anyone knowing to build first. The
// build is incremental, so repeat runs are almost free.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { shutdownOn } from './shutdown.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

const build = spawn(
  process.execPath,
  ['node_modules/typescript/bin/tsc', '--build', 'packages/db'],
  { cwd: repositoryRoot, shell: false, stdio: 'inherit' },
);

build.once('error', (error) => {
  process.stderr.write(`worker: could not build the db package: ${error.message}\n`);
  process.exit(1);
});

build.once('close', (code) => {
  if (code !== 0) {
    process.stderr.write('worker: the db package did not build\n');
    process.exit(code ?? 1);
  }
  void run();
});

async function run() {
  const connectionString = process.env['DATABASE_URL']?.trim();
  if (connectionString === undefined || connectionString === '') {
    process.stderr.write(
      'worker: DATABASE_URL is not set. Copy .env.example to .env and export it, or pass it inline.\n',
    );
    process.exit(1);
    return;
  }

  const { startWorker } = await import('../packages/db/dist/index.js');
  let worker;
  try {
    // No registrations yet: the engines that own queues arrive in later
    // sprints, and the process that will run them is proven before they do.
    worker = await startWorker({ connectionString }, []);
  } catch (error) {
    process.stderr.write(`worker: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
    return;
  }
  process.stdout.write('worker: ready\n');
  shutdownOn(['SIGTERM', 'SIGINT'], async () => {
    await worker.stop();
    process.stdout.write('worker: stopped\n');
  });
}
