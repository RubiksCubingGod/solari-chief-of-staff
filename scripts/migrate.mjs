#!/usr/bin/env node
// Applies the migration set to the database named by DATABASE_URL.
//
// The runner is TypeScript, so this builds the db package before importing it.
// That is deliberate: `pnpm migrate` is documented as the third step of setup,
// before anything else has built the workspace, and a setup step that fails
// because of an ordering rule nobody wrote down is exactly what the README is
// supposed to make unnecessary. The build is incremental, so repeat runs are
// almost free.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

const connectionString = process.env['DATABASE_URL']?.trim();
if (connectionString === undefined || connectionString === '') {
  process.stderr.write(
    'migrate: DATABASE_URL is not set. Copy .env.example to .env and export it, or pass it inline.\n',
  );
  process.exit(1);
}

const build = spawn(
  process.execPath,
  ['node_modules/typescript/bin/tsc', '--build', 'packages/db'],
  { cwd: repositoryRoot, shell: false, stdio: 'inherit' },
);

build.once('error', (error) => {
  process.stderr.write(`migrate: could not build the db package: ${error.message}\n`);
  process.exit(1);
});

build.once('close', (code) => {
  if (code !== 0) {
    process.stderr.write('migrate: the db package did not build\n');
    process.exit(code ?? 1);
  }
  void apply();
});

async function apply() {
  const { runMigrations } = await import('../packages/db/dist/index.js');
  try {
    await runMigrations(connectionString);
    process.stdout.write('migrate: the database is up to date\n');
  } catch (error) {
    process.stderr.write(`migrate: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
