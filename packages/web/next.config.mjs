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

/** @type {import('next').NextConfig} */
const config = {
  ...(distDir === undefined || distDir === '' ? {} : { distDir }),
};

export default config;
