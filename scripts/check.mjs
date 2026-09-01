#!/usr/bin/env node
// The quality gate from ARCHITECTURE §9.3, as one command: lint, typecheck,
// unit + integration tests with the coverage gate, then build.
//
// Steps invoke each tool's own entry point through the current Node binary
// rather than chaining package scripts, so the gate behaves identically under
// cmd.exe, POSIX shells, CI, and NAH's shell-free proof runner.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

const STEPS = [
  { name: 'lint', argv: ['node_modules/eslint/bin/eslint.js', '.'] },
  { name: 'typecheck', argv: ['node_modules/typescript/bin/tsc', '--build', '--force'] },
  {
    name: 'typecheck:tests',
    argv: ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.test.json'],
  },
  { name: 'test', argv: ['scripts/vitest.mjs', 'run', '--coverage'] },
  { name: 'build', argv: ['node_modules/typescript/bin/tsc', '--build'] },
];

/** @param {{name: string, argv: string[]}} step */
function runStep(step) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, step.argv, {
      cwd: repositoryRoot,
      shell: false,
      stdio: 'inherit',
    });
    child.once('error', (error) => {
      process.stderr.write(`check: ${step.name} could not start: ${error.message}\n`);
      resolve(1);
    });
    child.once('close', (code, signal) => {
      resolve(signal === null ? (code ?? 1) : 1);
    });
  });
}

for (const step of STEPS) {
  process.stdout.write(`\n--- check: ${step.name} ---\n`);
  const code = await runStep(step);
  if (code !== 0) {
    process.stderr.write(`\ncheck: ${step.name} failed with exit code ${code}\n`);
    process.exit(code);
  }
}

process.stdout.write('\ncheck: all steps passed\n');
