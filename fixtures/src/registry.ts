import { startFakedmvFixture } from './fakedmv.js';
import { startFakegymFixture } from './fakegym.js';
import { startFakenewsFixture } from './fakenews.js';
import { startFakestoreFixture } from './fakestore.js';
import type { FixtureHandle, StartFixtureOptions } from './harness.js';

/**
 * One entry per fixture site.
 *
 * `start` holds the very same factory the integration tests import. That
 * identity is the whole point of this registry and is asserted rather than
 * trusted: the development CLI and the compose service are entry points into
 * the tested boot path, never a second implementation that can drift away from
 * it while still looking correct.
 */
export interface FixtureSite {
  readonly name: string;
  /** Fixed, documented, and cross-checked against docker-compose.yml. */
  readonly port: number;
  readonly start: (options?: StartFixtureOptions) => Promise<FixtureHandle<unknown>>;
}

export const FIXTURE_SITES: readonly FixtureSite[] = [
  { name: 'fakestore', port: 4301, start: startFakestoreFixture },
  { name: 'fakenews', port: 4302, start: startFakenewsFixture },
  { name: 'fakegym', port: 4303, start: startFakegymFixture },
  { name: 'fakedmv', port: 4304, start: startFakedmvFixture },
];
