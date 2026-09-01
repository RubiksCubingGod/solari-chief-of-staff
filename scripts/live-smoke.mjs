#!/usr/bin/env node
// The live Solari smoke, run deliberately.
//
// The suite itself skips unless SOLARI_LIVE_SMOKE opts in, which is what keeps
// `pnpm check` from spending money. This script is the other side of that
// switch: it is how a human, or the nightly workflow, says yes on purpose.
//
// It refuses to run without a key rather than letting the suite skip, because a
// skipped suite exits zero and a proof that can pass without doing anything is
// not a proof. Since the script supplies both the flag and a non-empty key, the
// guard cannot skip, so exit zero here means the vendor was really called.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Read `.env` the way the rest of the workspace expects it to be read: as the
 * local stand-in for CI's secret store. Anything already in the environment
 * wins, so CI never has its secret overwritten by a checked-out file.
 */
function loadDotEnv() {
  let contents;
  try {
    contents = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  } catch {
    return; // No .env is normal in CI, where the secret arrives as an env var.
  }

  for (const line of contents.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    if (key === '' || process.env[key] !== undefined) continue;

    const raw = trimmed.slice(separator + 1).trim();
    const unquoted =
      (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
        ? raw.slice(1, -1)
        : raw;
    process.env[key] = unquoted;
  }
}

loadDotEnv();

const apiKey = (process.env['SOLARI_API_KEY'] ?? '').trim();
if (apiKey === '') {
  process.stderr.write(
    'SOLARI_API_KEY is not set. The live smoke calls the real vendor, so it fails here rather\n' +
      'than skipping: a skipped suite exits zero and would report a live run that never happened.\n' +
      'Set it in .env locally, or as a repository secret in CI.\n',
  );
  process.exit(1);
}

const child = spawn(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    '--project',
    'integration',
    'packages/solari/src/live.integration.test.ts',
  ],
  {
    cwd: repositoryRoot,
    shell: false,
    stdio: 'inherit',
    env: { ...process.env, SOLARI_API_KEY: apiKey, SOLARI_LIVE_SMOKE: '1' },
  },
);

child.once('error', (error) => {
  process.stderr.write(`vitest could not start: ${error.message}\n`);
  process.exit(1);
});

child.once('close', (code, signal) => {
  process.exit(signal === null ? (code ?? 1) : 1);
});
