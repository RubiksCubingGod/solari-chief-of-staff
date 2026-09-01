import { describe, expect, it } from 'vitest';

import {
  TEST_DATABASE_URL_VARIABLE,
  type TestPostgres,
  type TestPostgresStarters,
  startTestPostgres,
} from './postgres.js';

function recordingStarters(): TestPostgresStarters & { calls: string[] } {
  const calls: string[] = [];
  const stub = (connectionString: string): TestPostgres => ({
    connectionString,
    stop: () => Promise.resolve(),
  });
  return {
    calls,
    container: () => {
      calls.push('container');
      return Promise.resolve(stub('container'));
    },
    server: (serverUrl: string) => {
      calls.push(`server:${serverUrl}`);
      return Promise.resolve(stub(serverUrl));
    },
  };
}

describe('startTestPostgres', () => {
  it('uses a container when no server URL is configured', async () => {
    const starters = recordingStarters();

    await startTestPostgres({}, starters);

    expect(starters.calls).toEqual(['container']);
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
});
