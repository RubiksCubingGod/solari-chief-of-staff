/**
 * The dashboard's build directory, overridable from the environment.
 *
 * Next 16 takes an exclusive lock at `<distDir>/lock` and the loser calls
 * `process.exit(1)` rather than waiting, so two dev servers sharing a build
 * directory is not a flake - it is a hard kill of whichever process lost. The
 * integration suites each boot a dashboard in their own process, so each needs
 * its own directory, and this is the only lever that moves it: the `conf`
 * option `next()` accepts is discarded, because `loadConfig` caches on
 * `Boolean(customConfig)` rather than on its contents.
 *
 * Unset - which is every case except those tests - leaves Next on its default.
 */
const distDir = process.env.NEXT_DIST_DIR;

/**
 * Whether this instance is one of those tests.
 *
 * The inference is the variable's own meaning: a build directory named from the
 * environment is a directory something else chose, and the only thing that
 * chooses one here is `testing/dev-server.ts`, which names it with a fresh uuid
 * per instance.
 */
const isDisposableInstance = distDir !== undefined && distDir !== '';

/** @type {import('next').NextConfig} */
const config = {
  ...(isDisposableInstance ? { distDir } : {}),
  ...(isDisposableInstance
    ? {
        /**
         * No persistent cache for a build directory nothing will ever open
         * again.
         *
         * Turbopack's dev filesystem cache is on by default, and it is written
         * by a native thread that `app.close()` does not join. Against a uuid
         * directory that is deleted at teardown, that thread has no reader and
         * no time: it writes SST files nobody reads, into a directory that is
         * about to disappear, and when it disappears mid-write the failure is
         * not local to the instance that caused it -
         *
         *     Persisting failed: Unable to write SST file 00000025.sst
         *     Persisting is disabled for this session due to an unrecoverable
         *       error.
         *
         * - because "this session" is the process. Every later dev server in
         * that worker loses its caching too, and the turbo-tasks thread that
         * follows can panic long after the test that caused it has passed.
         *
         * Off here rather than fixed in teardown because there is no ordering
         * that makes this work worth doing: the cache is per instance, so it is
         * never read even when it is written perfectly. A real `next dev` sets
         * no `NEXT_DIST_DIR`, keeps its default directory across restarts, and
         * keeps its cache.
         */
        experimental: { turbopackFileSystemCacheForDev: false },
      }
    : {}),
};

export default config;
