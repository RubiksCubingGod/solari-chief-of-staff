#!/usr/bin/env node
// Shell-free entry point for Vitest.
//
// Package scripts, the quality gate, and NAH's proof runner all reach Vitest
// through this file, so a proof can name a path that exists in the repository
// instead of one that only appears after an install.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

const child = spawn(
  process.execPath,
  ['node_modules/vitest/vitest.mjs', ...process.argv.slice(2)],
  { cwd: repositoryRoot, shell: false, stdio: 'inherit' },
);

child.once('error', (error) => {
  process.stderr.write(`vitest could not start: ${error.message}\n`);
  process.exit(1);
});

child.once('close', (code, signal) => {
  process.exit(signal === null ? (code ?? 1) : 1);
});
