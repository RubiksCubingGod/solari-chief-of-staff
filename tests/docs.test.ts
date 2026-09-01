import { existsSync, readFileSync } from 'node:fs';

import { ConfigError, loadConfig } from '@chief-of-staff/api';
import { TEST_DATABASE_URL_VARIABLE } from '@chief-of-staff/db/testing';
import { describe, expect, it } from 'vitest';

/**
 * Documentation that is only read by people rots silently. These assertions
 * make the README and `.env.example` fail the build when they stop describing
 * this repository: a script that no longer exists, a file that moved, a
 * variable the config loader does not actually read, or a connection string
 * that does not match the database `docker compose up` starts.
 */

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const readme = read('../README.md');
const example = read('../.env.example');
const compose = read('../docker-compose.yml');
const manifest = JSON.parse(read('../package.json')) as { scripts: Record<string, string> };

/** `KEY=value` lines, ignoring comments and blanks. */
function parseEnv(contents: string): Record<string, string> {
  const entries = contents
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)] as const;
    });
  return Object.fromEntries(entries);
}

const documented = parseEnv(example);

describe('README.md', () => {
  it('only tells the reader to run scripts that exist', () => {
    const referenced = [...readme.matchAll(/`pnpm ([a-z:]+)`|^pnpm ([a-z:]+)$/gmu)].map(
      (match) => match[1] ?? match[2],
    );

    expect(referenced.length).toBeGreaterThan(0);
    for (const script of referenced) {
      if (script === 'install') continue;
      expect(Object.keys(manifest.scripts), `pnpm ${String(script)}`).toContain(script);
    }
  });

  it('only points at files that exist', () => {
    const paths = [...readme.matchAll(/`((?:docs|packages|scripts|tests|fixtures)\/[\w./-]+)`/gu)]
      .map((match) => match[1] ?? '')
      .filter((path) => !path.endsWith('/'));

    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(existsSync(new URL(`../${path}`, import.meta.url)), path).toBe(true);
    }
  });

  it('documents the setup in the order it has to happen', () => {
    // The first shell block is the clone-to-green sequence; a step out of order
    // there is a stranger's first ten minutes wasted.
    const setup = /```bash\n([\s\S]*?)```/u.exec(readme)?.[1] ?? '';
    const steps = ['pnpm install', 'docker compose up', 'pnpm migrate', 'pnpm check'];
    const positions = steps.map((step) => setup.indexOf(step));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

describe('.env.example', () => {
  it('is enough on its own to configure the server', () => {
    const config = loadConfig(documented);

    expect(config).toEqual({
      databaseUrl: documented['DATABASE_URL'],
      host: documented['HOST'],
      logLevel: documented['LOG_LEVEL'],
      port: Number(documented['PORT']),
      runtimeEnvironment: documented['NODE_ENV'],
    });
  });

  it('documents the connection string the server cannot start without', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(documented['DATABASE_URL']).toBeTruthy();
  });

  it('points that connection string at the database docker compose starts', () => {
    const url = new URL(String(documented['DATABASE_URL']));
    const composed = parseEnv(
      compose
        .split('\n')
        .filter((line) => line.trim().startsWith('POSTGRES_'))
        .map((line) => line.trim().replace(': ', '='))
        .join('\n'),
    );

    expect(url.username).toBe(composed['POSTGRES_USER']);
    expect(url.password).toBe(composed['POSTGRES_PASSWORD']);
    expect(url.pathname).toBe(`/${String(composed['POSTGRES_DB'])}`);
    // The compose port is overridable and defaults to 5432; the example has to
    // name the default, or the two documents disagree out of the box.
    expect(url.port).toBe('5432');
    expect(documented['POSTGRES_PORT']).toBe('5432');
  });

  it('names the test-database escape hatch the harness actually looks for', () => {
    expect(Object.keys(documented)).toContain(TEST_DATABASE_URL_VARIABLE);
    // Blank: the default path is a throwaway container, and a value left here
    // would silently redirect every integration test at a shared server.
    expect(documented[TEST_DATABASE_URL_VARIABLE]).toBe('');
  });
});
