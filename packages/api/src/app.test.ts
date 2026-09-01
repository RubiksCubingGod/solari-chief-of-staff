import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import type { ErrorEnvelope } from './errors.js';

const ENVIRONMENT: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://user@localhost:5432/chief_of_staff',
  LOG_LEVEL: 'silent',
  NODE_ENV: 'test',
  PORT: '4010',
};

const apps: { close(): Promise<void> }[] = [];

function app(): ReturnType<typeof createApp> {
  const instance = createApp(ENVIRONMENT);
  apps.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((instance) => instance.close()));
  vi.unstubAllEnvs();
});

describe('the api app factory', () => {
  it('boots with the configuration it read from the environment', async () => {
    const instance = app();
    await instance.ready();

    expect(instance.config).toEqual({
      databaseUrl: 'postgres://user@localhost:5432/chief_of_staff',
      host: '127.0.0.1',
      logLevel: 'silent',
      port: 4010,
      runtimeEnvironment: 'test',
    });
  });

  it('falls back to the real process environment when given none', async () => {
    for (const [name, value] of Object.entries(ENVIRONMENT)) vi.stubEnv(name, value ?? '');
    const instance = createApp();
    apps.push(instance);

    await instance.ready();

    expect(instance.config.port).toBe(4010);
  });

  it('answers GET /health with 200', async () => {
    const response = await app().inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('refuses a malformed JSON body with the typed envelope', async () => {
    const instance = app();
    instance.post('/probe', () => ({ ok: true }));

    const response = await instance.inject({
      method: 'POST',
      url: '/probe',
      headers: { 'content-type': 'application/json' },
      payload: '{"kind":',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorEnvelope>().error.code).toBe('malformed_json');
  });

  it('reports every schema violation as one validation_failed envelope', async () => {
    const instance = app();
    instance.post(
      '/probe',
      {
        schema: {
          body: {
            type: 'object',
            required: ['kind', 'url'],
            properties: {
              kind: { type: 'string', enum: ['price', 'slot', 'change'] },
              url: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
      },
      () => ({ ok: true }),
    );

    const response = await instance.inject({
      method: 'POST',
      url: '/probe',
      payload: { kind: 'nonsense' },
    });

    expect(response.statusCode).toBe(400);
    const { error } = response.json<ErrorEnvelope>();
    expect(error.code).toBe('validation_failed');
    expect(error.details).toEqual([
      { path: '', message: "must have required property 'url'" },
      { path: '/kind', message: 'must be equal to one of the allowed values' },
    ]);
  });

  it('answers an unknown route with the not_found envelope', async () => {
    const response = await app().inject({ method: 'GET', url: '/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorEnvelope>()).toEqual({
      error: { code: 'not_found', message: 'Route GET /nope does not exist.' },
    });
  });

  it('passes through a 4xx a route raised itself, without inventing a code', async () => {
    const instance = app();
    instance.get('/probe', (_request, reply) => reply.status(409).send({ conflict: true }));

    const response = await instance.inject({ method: 'GET', url: '/probe' });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ conflict: true });
  });

  it('maps an unmapped 4xx a route threw to the generic bad_request code', async () => {
    const instance = app();
    instance.get('/probe', () => {
      throw Object.assign(new Error('too many of those'), { statusCode: 429 });
    });

    const response = await instance.inject({ method: 'GET', url: '/probe' });

    expect(response.statusCode).toBe(429);
    expect(response.json<ErrorEnvelope>()).toEqual({
      error: { code: 'bad_request', message: 'too many of those' },
    });
  });

  it('never leaks the reason a handler crashed', async () => {
    const instance = app();
    instance.get('/probe', () => {
      throw new Error('connection string postgres://user:hunter2@db/app refused');
    });

    const response = await instance.inject({ method: 'GET', url: '/probe' });

    expect(response.statusCode).toBe(500);
    expect(response.json<ErrorEnvelope>()).toEqual({
      error: { code: 'internal_error', message: 'The server failed to handle the request.' },
    });
    expect(response.body).not.toContain('hunter2');
  });
});
