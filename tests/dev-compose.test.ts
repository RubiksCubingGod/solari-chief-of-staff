import { readFileSync } from 'node:fs';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * `docker compose up` is the documented way to get a development database, so
 * the compose file has to stay internally consistent: a healthcheck that names
 * a different user than the server was created with reports ready for a
 * database nobody can log into.
 */

interface ComposeFile {
  services: Record<
    string,
    {
      image?: string;
      environment?: Record<string, string>;
      ports?: string[];
      volumes?: string[];
      healthcheck?: { test?: string[] };
    }
  >;
  volumes?: Record<string, unknown>;
}

const compose = parse(
  readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8'),
) as ComposeFile;

const postgres = compose.services.postgres;

describe('docker-compose.yml', () => {
  it('runs the same Postgres major version the test harness does', () => {
    expect(postgres?.image).toMatch(/^postgres:17(?:[.-]|$)/);
  });

  it('leaves the host port overridable so it cannot collide with a local server', () => {
    expect(postgres?.ports).toEqual(['${POSTGRES_PORT:-5432}:5432']);
  });

  it('keeps the healthcheck pointed at the credentials the server is created with', () => {
    const environment = postgres?.environment ?? {};
    const user = environment['POSTGRES_USER'];
    const database = environment['POSTGRES_DB'];

    expect(user).toBeTruthy();
    expect(database).toBeTruthy();
    expect(environment['POSTGRES_PASSWORD']).toBeTruthy();

    const check = (postgres?.healthcheck?.test ?? []).join(' ');
    expect(check).toContain('pg_isready');
    expect(check).toContain(`-U ${String(user)}`);
    expect(check).toContain(`-d ${String(database)}`);
  });

  it('persists data in a declared named volume', () => {
    expect(postgres?.volumes).toEqual(['postgres-data:/var/lib/postgresql/data']);
    expect(Object.keys(compose.volumes ?? {})).toContain('postgres-data');
  });
});
