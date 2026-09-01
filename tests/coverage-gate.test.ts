import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CORE_COVERAGE_GLOB, coverageThresholds } from '../vitest.config.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * The gate from ARCHITECTURE §9.3 is only a gate if it actually refuses work.
 * Rather than proving that with a throwaway commit that has to be reverted,
 * this runs Vitest over a fixture that deliberately leaves one branch
 * unexercised, held to exactly the thresholds `core/` is held to, and requires
 * the run to fail.
 */
describe('the coverage gate', () => {
  it(
    'fails a run that leaves a branch unexercised',
    () => {
      const config = fileURLToPath(
        new URL('./fixtures/coverage-gate/vitest.config.ts', import.meta.url),
      );
      const result = spawnSync(
        process.execPath,
        ['scripts/vitest.mjs', 'run', '--coverage', '--config', config],
        { cwd: repositoryRoot, encoding: 'utf8' },
      );

      const output = `${result.stdout}${result.stderr}`;
      // The fixture's own test passes. The run still fails, and it fails
      // naming the branch nobody exercised - not for some unrelated reason.
      expect(output).toMatch(/1 passed/u);
      expect(output).toMatch(/Coverage for branches \(50%\) does not meet .*threshold \(100%\)/u);
      expect(result.status).not.toBe(0);
    },
    120_000,
  );

  it('holds core to every line and the workspace to the section 9.3 floor', () => {
    expect(coverageThresholds).toMatchObject({
      lines: 90,
      functions: 90,
      branches: 90,
      statements: 90,
    });
    expect(coverageThresholds[CORE_COVERAGE_GLOB]).toEqual({
      lines: 100,
      functions: 100,
      branches: 100,
      statements: 100,
    });
  });

  it('points the stricter threshold at source that exists', () => {
    expect(CORE_COVERAGE_GLOB).toBe('packages/core/src/**/*.ts');
    const sources = readdirSync(new URL('../packages/core/src', import.meta.url), {
      recursive: true,
    })
      .map((entry) => String(entry))
      .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'));
    expect(sources.length).toBeGreaterThan(0);
  });
});
