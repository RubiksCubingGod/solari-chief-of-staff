import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const WORKSPACE_PACKAGES = [
  'core',
  'db',
  'solari',
  'agent',
  'playbooks',
  'api',
  'bot',
  'web',
] as const;

/**
 * Tests import workspace packages by name but resolve to their TypeScript
 * source, so a test run never depends on a prior build and coverage is
 * attributed to source lines rather than emitted output.
 */
const sourceAliases = {
  /**
   * Every package's integration tests start Postgres through the db package's
   * helper. It is source-only - excluded from that package's build and from its
   * published exports - so it is aliased explicitly, and listed first because
   * the bare `@chief-of-staff/db` alias would otherwise swallow the subpath.
   */
  '@chief-of-staff/db/testing': fileURLToPath(
    new URL('./packages/db/src/testing/postgres.ts', import.meta.url),
  ),
  /**
   * The dashboard's guard test drives a browser through the whole magic-link
   * flow, so it needs a real API on a real database - and it may not build one,
   * because `eslint.config.js` keeps `packages/web` away from the schema. The
   * API package builds the fixture instead and hands over a URL. Source-only
   * and excluded from that package's build, so like the db helper above it is
   * aliased explicitly and listed before the bare package alias, which would
   * otherwise swallow the subpath.
   */
  '@chief-of-staff/api/testing': fileURLToPath(
    new URL('./packages/api/src/testing/auth-stack.ts', import.meta.url),
  ),
  /**
   * The fixture sites live outside `packages/`, so they are aliased explicitly
   * rather than through the workspace-package list below.
   */
  '@chief-of-staff/fixtures': fileURLToPath(
    new URL('./fixtures/src/index.ts', import.meta.url),
  ),
  ...Object.fromEntries(
    WORKSPACE_PACKAGES.map((name) => [
      `@chief-of-staff/${name}`,
      fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url)),
    ]),
  ),
};

/**
 * The coverage gate from ARCHITECTURE §9.3. Exported so the gate itself is
 * assertable in a unit test instead of being trusted by inspection.
 */
export const CORE_COVERAGE_GLOB = 'packages/core/src/**/*.ts';

export const coverageThresholds = {
  lines: 90,
  functions: 90,
  branches: 90,
  statements: 90,
  [CORE_COVERAGE_GLOB]: {
    lines: 100,
    functions: 100,
    branches: 100,
    statements: 100,
  },
};

/**
 * How many test files may be in flight at once.
 *
 * Fewer than there are cores, on purpose. What bounds this run is memory rather
 * than CPU: an integration file here can be a Postgres container, or a Next dev
 * server compiling a route with a Chromium beside it, and there are enough of
 * both that one process per core asks for more memory than a developer
 * workstation running an editor and a browser has left. Oversubscribed, the
 * failures do not look like memory - they look like a container that took more
 * than two minutes to accept connections and an ESLint run that took three,
 * which is to say like flakes in whichever suites happened to be scheduled
 * together.
 *
 * Capped rather than fixed, so a smaller machine still gets one process per
 * core and does not end up with eight of them fighting over four.
 */
const MAX_CONCURRENT_TEST_FILES = Math.min(8, availableParallelism());

const TEST_FILE_GLOBS = ['**/*.test.ts', '**/*.integration.test.ts'];
const ALWAYS_EXCLUDED = ['**/node_modules/**', '**/dist/**', '**/coverage/**'];

export default defineConfig({
  resolve: { alias: sourceAliases },
  test: {
    maxWorkers: MAX_CONCURRENT_TEST_FILES,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
          exclude: [...ALWAYS_EXCLUDED, '**/*.integration.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: [
            'packages/*/src/**/*.integration.test.ts',
            'tests/**/*.integration.test.ts',
            'fixtures/src/**/*.integration.test.ts',
          ],
          exclude: ALWAYS_EXCLUDED,
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        ...TEST_FILE_GLOBS,
        // The two ends of the test-database ladder, each of which only one kind
        // of machine executes. The container adapter cannot run on a
        // workstation without Docker, and on CI it is the path every
        // integration test already takes; the embedded cluster is the exact
        // opposite, reached only where no container runtime answered. Their
        // selection logic lives in `postgres.ts`, which is covered.
        'packages/db/src/testing/testcontainers.ts',
        'packages/db/src/testing/embedded.ts',
      ],
      thresholds: coverageThresholds,
    },
  },
});
