import { describe, expect, it } from 'vitest';

import {
  TEST_DATABASE_URL_VARIABLE,
  TEST_POSTGRES_STARTER_VARIABLE,
  type TestPostgres,
  type TestPostgresStarters,
  startTestPostgres,
} from './postgres.js';

interface RecordingOptions {
  readonly containerFails?: string;
  readonly embeddedFails?: string;
}

function recordingStarters(
  options: RecordingOptions = {},
): TestPostgresStarters & { calls: string[] } {
  const calls: string[] = [];
  const stub = (connectionString: string): TestPostgres => ({
    connectionString,
    stop: () => Promise.resolve(),
  });
  return {
    calls,
    container: () => {
      calls.push('container');
      return options.containerFails === undefined
        ? Promise.resolve(stub('container'))
        : Promise.reject(new Error(options.containerFails));
    },
    embedded: () => {
      calls.push('embedded');
      return options.embeddedFails === undefined
        ? Promise.resolve(stub('embedded'))
        : Promise.reject(new Error(options.embeddedFails));
    },
    server: (serverUrl: string) => {
      calls.push(`server:${serverUrl}`);
      return Promise.resolve(stub(serverUrl));
    },
  };
}

describe('startTestPostgres', () => {
  it('prefers a container when no server URL is configured', async () => {
    const starters = recordingStarters();

    const postgres = await startTestPostgres({}, starters);

    expect(starters.calls).toEqual(['container']);
    expect(postgres.connectionString).toBe('container');
  });

  it('treats a blank server URL as unset rather than a connection string', async () => {
    const starters = recordingStarters();

    await startTestPostgres({ [TEST_DATABASE_URL_VARIABLE]: '   ' }, starters);

    expect(starters.calls).toEqual(['container']);
  });

  it('creates its database on the configured server when one is given', async () => {
    const starters = recordingStarters();
    const serverUrl = 'postgres://user@localhost:5432/postgres';

    const postgres = await startTestPostgres(
      { [TEST_DATABASE_URL_VARIABLE]: serverUrl },
      starters,
    );

    expect(starters.calls).toEqual([`server:${serverUrl}`]);
    expect(postgres.connectionString).toBe(serverUrl);
  });

  it('falls back to an embedded cluster when no container runtime answers', async () => {
    const starters = recordingStarters({ containerFails: 'Could not find a working container runtime' });

    const postgres = await startTestPostgres({}, starters);

    expect(starters.calls).toEqual(['container', 'embedded']);
    expect(postgres.connectionString).toBe('embedded');
  });

  it('reports both failures together when neither a container nor an embedded cluster starts', async () => {
    const starters = recordingStarters({
      containerFails: 'no docker daemon',
      embeddedFails: 'initdb refused',
    });

    // One report naming both rungs: a developer with a broken toolchain should
    // not have to fix the container error only to discover the embedded one.
    await expect(startTestPostgres({}, starters)).rejects.toThrow(
      /no docker daemon[\s\S]*initdb refused/,
    );
    expect(starters.calls).toEqual(['container', 'embedded']);
  });

  it('pins the embedded cluster when the starter variable selects it', async () => {
    const starters = recordingStarters();

    const postgres = await startTestPostgres(
      { [TEST_POSTGRES_STARTER_VARIABLE]: 'embedded' },
      starters,
    );

    // No container attempt at all: pinning is how a machine that *has* Docker
    // reproduces the no-container path deliberately.
    expect(starters.calls).toEqual(['embedded']);
    expect(postgres.connectionString).toBe('embedded');
  });

  it('pins the container when the starter variable selects it, even with a server URL set', async () => {
    const starters = recordingStarters();

    await startTestPostgres(
      {
        [TEST_POSTGRES_STARTER_VARIABLE]: 'container',
        [TEST_DATABASE_URL_VARIABLE]: 'postgres://user@localhost:5432/postgres',
      },
      starters,
    );

    expect(starters.calls).toEqual(['container']);
  });

  it('does not fall back when a pinned container fails', async () => {
    const starters = recordingStarters({ containerFails: 'no docker daemon' });

    await expect(
      startTestPostgres({ [TEST_POSTGRES_STARTER_VARIABLE]: 'container' }, starters),
    ).rejects.toThrow('no docker daemon');
    expect(starters.calls).toEqual(['container']);
  });

  it('refuses a pinned server with no server URL rather than silently starting something else', async () => {
    const starters = recordingStarters();

    await expect(
      startTestPostgres({ [TEST_POSTGRES_STARTER_VARIABLE]: 'server' }, starters),
    ).rejects.toThrow(TEST_DATABASE_URL_VARIABLE);
    expect(starters.calls).toEqual([]);
  });

  it('refuses a starter name it does not know', async () => {
    const starters = recordingStarters();

    await expect(
      startTestPostgres({ [TEST_POSTGRES_STARTER_VARIABLE]: 'sqlite' }, starters),
    ).rejects.toThrow(/sqlite/);
    expect(starters.calls).toEqual([]);
  });
});
