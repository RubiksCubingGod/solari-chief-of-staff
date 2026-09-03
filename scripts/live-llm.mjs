#!/usr/bin/env node
// The live model runs, run deliberately.
//
// Two suites talk to the real model: the chat loop's, in packages/agent, and
// the agentic smoke, in packages/playbooks. Both skip unless ANTHROPIC_LIVE_LLM
// opts in, which is what keeps `pnpm check` from spending money. This script
// is the other side of that switch: how a human, or the nightly workflow, says
// yes on purpose.
//
// It refuses to run without a key rather than letting the suites skip, because
// a skipped suite exits zero and a proof that can pass without doing anything
// is not a proof. Since the script supplies both the flag and a non-empty key,
// the guard cannot skip, so exit zero here means the model was really called.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

/** The suites, and the name every live test in them carries. */
const LIVE_SUITES = [
  'packages/agent/src/live-llm.integration.test.ts',
  'packages/playbooks/src/agentic-mission.integration.test.ts',
];
const LIVE_TAG = '@live-llm';

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

const apiKey = (process.env['ANTHROPIC_API_KEY'] ?? '').trim();
if (apiKey === '') {
  process.stderr.write(
    'ANTHROPIC_API_KEY is not set. The live runs call the real model, so this fails here rather\n' +
      'than skipping: a skipped suite exits zero and would report a live run that never happened.\n' +
      'Set it in .env locally, or as a repository secret in CI.\n',
  );
  process.exit(1);
}

// Only the tests tagged live: the scripted tests beside them have their own
// place in `pnpm check`, and a nightly that reran them would say nothing new.
const child = spawn(
  process.execPath,
  ['scripts/vitest.mjs', 'run', '--project', 'integration', '-t', LIVE_TAG, ...LIVE_SUITES],
  {
    cwd: repositoryRoot,
    stdio: 'inherit',
    env: { ...process.env, ANTHROPIC_API_KEY: apiKey, ANTHROPIC_LIVE_LLM: '1' },
  },
);

child.on('error', (error) => {
  process.stderr.write(`live-llm: could not start vitest: ${error.message}\n`);
  process.exit(1);
});

child.on('close', (code, signal) => {
  if (signal !== null) {
    process.stderr.write(`live-llm: vitest was stopped by ${signal}\n`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
