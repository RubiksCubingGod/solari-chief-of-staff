#!/usr/bin/env node
// Serves every fixture site on its documented port. Documented as `pnpm fixtures:dev`.
//
// The fixtures are TypeScript, so this builds the package before importing it,
// for the same reason `pnpm start` does: a documented command has to work from
// a fresh clone without anyone knowing to build first. The build is
// incremental, so repeat runs are almost free.
//
// This is an entry point into the same `start*Fixture()` factories the
// integration tests call, never a second implementation - see
// fixtures/src/registry.ts.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { shutdownOn } from './shutdown.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

const build = spawn(
  process.execPath,
  ['node_modules/typescript/bin/tsc', '--build', 'fixtures'],
  { cwd: repositoryRoot, shell: false, stdio: 'inherit' },
);

build.once('error', (error) => {
  process.stderr.write(`fixtures: could not build the fixtures package: ${error.message}\n`);
  process.exit(1);
});

build.once('close', (code) => {
  if (code !== 0) {
    process.stderr.write('fixtures: the fixtures package did not build\n');
    process.exit(code ?? 1);
  }
  void run();
});

async function run() {
  const { startAllFixtures } = await import('../fixtures/dist/serve.js');
  let fixtures;
  try {
    fixtures = await startAllFixtures({ host: process.env.FIXTURES_HOST });
  } catch (error) {
    process.stderr.write(`fixtures: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
    return;
  }
  for (const { name, url } of fixtures.served) {
    process.stdout.write(`fixtures: ${name} on ${url}\n`);
  }
  shutdownOn(['SIGTERM', 'SIGINT'], async () => {
    await fixtures.stop();
    process.stdout.write('fixtures: stopped\n');
  });
}
