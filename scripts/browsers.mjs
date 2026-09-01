#!/usr/bin/env node
// Downloads the Chromium build LocalProvider drives. Documented as `pnpm browsers`.
//
// `pnpm install` deliberately does not fetch it: the browser is ~150 MB, it is
// pinned to the Playwright version in `packages/solari`, and only the provider
// contract suite needs it. Keeping it a separate, named step means an install
// stays fast and the one command that fixes "Chromium is not installed" is the
// one LocalProvider's own error message tells you to run.
//
// Shell-free and pathed from the repository root for the same reason the other
// entry points here are: it has to behave identically under cmd.exe, a POSIX
// shell, CI, and NAH's proof runner.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

// hoist=false keeps the CLI in the package that declares Playwright rather than
// at the workspace root.
const cli = 'packages/solari/node_modules/playwright/cli.js';

const child = spawn(process.execPath, [cli, 'install', 'chromium', ...process.argv.slice(2)], {
  cwd: repositoryRoot,
  shell: false,
  stdio: 'inherit',
});

child.once('error', (error) => {
  process.stderr.write(`browsers: playwright could not start: ${error.message}\n`);
  process.exit(1);
});

child.once('close', (code, signal) => {
  process.exit(signal === null ? (code ?? 1) : 1);
});
