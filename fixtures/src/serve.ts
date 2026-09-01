import type { FixtureHandle } from './harness.js';
import { FIXTURE_SITES } from './registry.js';

export interface ServedFixture {
  readonly name: string;
  readonly url: string;
  readonly handle: FixtureHandle<unknown>;
}

export interface ServedFixtures {
  readonly served: readonly ServedFixture[];
  stop(): Promise<void>;
}

export interface StartAllOptions {
  /**
   * Interface to bind. Defaults to loopback; the compose service passes
   * `0.0.0.0` so the published ports are reachable from the host.
   */
  readonly host?: string;
}

/**
 * Boots every fixture on its documented port, through the registry - which is
 * to say, through the same factories the integration tests call.
 *
 * If any one of them fails to bind, the ones already up are stopped before the
 * error propagates, so a port collision leaves nothing behind holding a port.
 */
export async function startAllFixtures(options: StartAllOptions = {}): Promise<ServedFixtures> {
  const started: ServedFixture[] = [];

  const stop = async (): Promise<void> => {
    await Promise.all(started.map((fixture) => fixture.handle.stop()));
    started.length = 0;
  };

  try {
    for (const site of FIXTURE_SITES) {
      const handle = await site.start({
        port: site.port,
        // Spread rather than pass `host: undefined`: under
        // exactOptionalPropertyTypes an absent option and an undefined one are
        // different types, and only the former means "take the default".
        ...(options.host === undefined ? {} : { host: options.host }),
      });
      started.push({ name: site.name, url: handle.url, handle });
    }
  } catch (error) {
    await stop();
    throw error;
  }

  return { served: [...started], stop };
}
