import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import { startFakedmvFixture } from './fakedmv.js';
import { startFakegymFixture } from './fakegym.js';
import { startFakenewsFixture } from './fakenews.js';
import { startFakestoreFixture } from './fakestore.js';
import { assertNoLeakedFixtures } from './harness.js';
import { FIXTURE_SITES } from './registry.js';
import { startAllFixtures } from './serve.js';

afterEach(() => {
  assertNoLeakedFixtures();
});

const repositoryRoot = new URL('../../', import.meta.url);

function readRepositoryFile(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, repositoryRoot)), 'utf8');
}

/**
 * Pulls the ```routes block that follows each site's heading in the README.
 * The heading also carries the port, so one parse covers both claims the
 * documentation makes about a site.
 */
function documentedSites(readme: string): Map<string, { port: number; routes: string[] }> {
  const sites = new Map<string, { port: number; routes: string[] }>();
  const pattern = /### (\S+) \(port (\d+)\)[\s\S]*?```routes\n([\s\S]*?)```/g;
  for (const match of readme.matchAll(pattern)) {
    const [, name = '', port = '0', block = ''] = match;
    sites.set(name, {
      port: Number(port),
      routes: block
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .sort(),
    });
  }
  return sites;
}

describe('the fixtures development entrypoint', () => {
  it('registers the very same factories the integration tests import', () => {
    const byName = new Map(FIXTURE_SITES.map((site) => [site.name, site.start]));

    // Identity, not behaviour: a lookalike wrapper would pass a behavioural
    // check and still be the second implementation this task exists to prevent.
    expect(byName.get('fakestore')).toBe(startFakestoreFixture);
    expect(byName.get('fakenews')).toBe(startFakenewsFixture);
    expect(byName.get('fakegym')).toBe(startFakegymFixture);
    expect(byName.get('fakedmv')).toBe(startFakedmvFixture);
    expect(FIXTURE_SITES).toHaveLength(4);
  });

  it('serves all four fixtures and their control planes on the documented ports', async () => {
    const fixtures = await startAllFixtures();
    try {
      expect(fixtures.served.map((fixture) => fixture.name)).toEqual([
        'fakestore',
        'fakenews',
        'fakegym',
        'fakedmv',
      ]);

      for (const site of FIXTURE_SITES) {
        const served = fixtures.served.find((fixture) => fixture.name === site.name);
        expect(served?.url).toBe(`http://127.0.0.1:${site.port}`);
      }

      // Each site answers on a control-plane route that only it has, so this
      // cannot pass by four handles pointing at the same app.
      const [store, news, gym, dmv] = fixtures.served.map((fixture) => fixture.url);
      expect((await fetch(`${store ?? ''}/__test/mode`)).status).toBe(200);
      expect((await fetch(`${news ?? ''}/__test/mode`)).status).toBe(200);
      expect((await fetch(`${gym ?? ''}/__test/member/nobody`)).status).toBe(404);
      expect(await (await fetch(`${dmv ?? ''}/__test/bookings`)).json()).toEqual([]);
    } finally {
      await fixtures.stop();
    }
  });

  it('releases every port when the entrypoint stops', async () => {
    const first = await startAllFixtures();
    await first.stop();

    // Rebinding the same fixed ports is the only honest proof they were freed.
    const second = await startAllFixtures();
    await second.stop();

    expect(second.served).toHaveLength(4);
  });

  it('documents exactly the routes each fixture actually mounts', async () => {
    const documented = documentedSites(readRepositoryFile('fixtures/README.md'));
    expect([...documented.keys()].sort()).toEqual(
      FIXTURE_SITES.map((site) => site.name).sort(),
    );

    for (const site of FIXTURE_SITES) {
      const handle = await site.start();
      try {
        expect(documented.get(site.name)?.routes, `${site.name} route documentation`).toEqual(
          [...handle.routes].sort(),
        );
      } finally {
        await handle.stop();
      }
    }
  });

  it('documents the same ports the registry and docker-compose use', () => {
    const documented = documentedSites(readRepositoryFile('fixtures/README.md'));
    const compose = parse(readRepositoryFile('docker-compose.yml')) as {
      services: Record<string, { ports?: string[] }>;
    };
    const published = (compose.services.fixtures?.ports ?? []).map((mapping) =>
      Number(mapping.split(':').at(-1)),
    );

    expect(published).toEqual(FIXTURE_SITES.map((site) => site.port));
    for (const site of FIXTURE_SITES) {
      expect(documented.get(site.name)?.port, `${site.name} port documentation`).toBe(site.port);
    }
  });

  it('publishes the compose ports on loopback, keeping the control plane unreachable off-host', () => {
    const compose = parse(readRepositoryFile('docker-compose.yml')) as {
      services: Record<string, { ports?: string[] }>;
    };
    const mappings = compose.services.fixtures?.ports ?? [];

    expect(mappings).toHaveLength(FIXTURE_SITES.length);
    for (const mapping of mappings) {
      // `/__test/*` is unauthenticated and mutable. The harness contract's
      // reason that is acceptable is that an instance is only reachable over
      // loopback, so a published port that omits the host binding withdraws the
      // premise rather than merely widening access.
      expect(mapping, `${mapping} must be published on loopback`).toMatch(/^127\.0\.0\.1:/);
    }
  });

  it('exposes the entrypoint as the documented pnpm command', () => {
    const manifest = JSON.parse(readRepositoryFile('package.json')) as {
      scripts: Record<string, string>;
    };

    expect(manifest.scripts['fixtures:dev']).toBe('node scripts/fixtures.mjs');
    expect(readRepositoryFile('scripts/fixtures.mjs')).toContain('startAllFixtures');
  });
});
