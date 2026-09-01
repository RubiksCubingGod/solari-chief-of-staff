import { defineConfig } from 'vitest/config';

import { CORE_COVERAGE_GLOB, coverageThresholds } from '../../../vitest.config.js';

/**
 * Not part of any test run of its own: `tests/coverage-gate.test.ts` invokes
 * Vitest with this config and requires the run to fail. The thresholds are the
 * real ones the workspace holds `core/` to, imported rather than restated, so
 * lowering the real gate makes the proof of the gate stop failing.
 */
export default defineConfig({
  test: {
    // Repository-root relative, because the runner is invoked from there and
    // only the config file is passed with `--config`.
    include: ['tests/fixtures/coverage-gate/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary'],
      // Its own directory: this run happens inside another Vitest run, and the
      // two would otherwise clear each other's temporary coverage files.
      reportsDirectory: 'tests/fixtures/coverage-gate/.coverage',
      include: ['tests/fixtures/coverage-gate/subject.ts'],
      thresholds: coverageThresholds[CORE_COVERAGE_GLOB],
    },
  },
});
