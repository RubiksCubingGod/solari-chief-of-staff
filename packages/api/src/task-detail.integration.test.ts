import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';

import type { TaskStatus } from '@chief-of-staff/core';
import { runMigrations, taskEvents, tasks, users } from '@chief-of-staff/db';
import { startTestPostgres, type TestPostgres } from '@chief-of-staff/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { mintSessionCookie } from './auth/session.js';

/**
 * The task detail read, grown for the page that replays a task.
 *
 * Two things are proven here that the browser suite cannot pin as precisely:
 * that the trail comes back oldest first with the row it belongs to, and that
 * the recording reaches the caller as plain NDJSON whatever the store did to
 * it. The store here is a local server that answers the three ways a real one
 * has been seen to, plus the two ways it can fail, so that "the API normalises
 * the body" is a fact about bytes and not about one provider's mood.
 */

const SESSION_SECRET = 'the-secret-this-suite-configured';

/** Two rrweb events: enough to be a recording, short enough to compare byte for byte. */
const RECORDING = [
  '{"type":4,"data":{"href":"https://fake.gym/","width":1280,"height":720},"timestamp":1}',
  '{"type":2,"data":{"node":{"type":0,"childNodes":[],"id":1}},"timestamp":2}',
  '',
].join('\n');

interface DetailEvent {
  readonly seq: number;
  readonly ts: string;
  readonly type: string;
  readonly payload: unknown;
}

interface TaskDetail {
  readonly id: string;
  readonly status: string;
  readonly events: readonly DetailEvent[];
  readonly recording: { readonly available: boolean; readonly href?: string };
}

let postgres: TestPostgres;
let app: FastifyInstance;
let ownerId: string;
let strangerId: string;
let store: Server;
let storeUrl: string;
let storeHits: string[] = [];
/** An address nothing listens on, so a fetch to it is refused at once. */
let deadStoreUrl: string;

async function createUser(telegramChatId: string): Promise<string> {
  const [created] = await app.db.insert(users).values({ telegramChatId }).returning();
  if (created === undefined) throw new Error('the fixture user was not created');
  return created.id;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(port)}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

beforeAll(async () => {
  postgres = await startTestPostgres();
  await runMigrations(postgres.connectionString);
  app = createApp({
    DATABASE_URL: postgres.connectionString,
    LOG_LEVEL: 'silent',
    SESSION_SECRET,
  });
  await app.ready();
  ownerId = await createUser('owner');
  strangerId = await createUser('stranger');

  const gzipped = gzipSync(RECORDING);
  store = createServer((request, response) => {
    storeHits.push(request.url ?? '');
    switch (request.url) {
      case '/plain':
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        response.end(RECORDING);
        return;
      case '/gzip':
        response.writeHead(200, { 'content-type': 'application/x-ndjson', 'content-encoding': 'gzip' });
        response.end(gzipped);
        return;
      case '/raw-gzip':
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(gzipped);
        return;
      default:
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('gone');
    }
  });
  storeUrl = await listen(store);
  const placeholder = createServer();
  deadStoreUrl = await listen(placeholder);
  await close(placeholder);
});

afterAll(async () => {
  try {
    await close(store);
    await app.close();
  } finally {
    await postgres.stop();
  }
});

beforeEach(async () => {
  await app.db.delete(taskEvents);
  await app.db.delete(tasks);
  storeHits = [];
});

function as(userId: string): Record<string, string> {
  return { cookie: mintSessionCookie(userId, SESSION_SECRET) };
}

async function createTask(
  userId: string,
  overrides: { readonly status?: TaskStatus; readonly recordingUrl?: string } = {},
): Promise<string> {
  const [created] = await app.db
    .insert(tasks)
    .values({
      userId,
      kind: 'cancel',
      input: { note: 'fake gym' },
      status: overrides.status ?? 'succeeded',
      mode: 'playbook',
      recordingUrl: overrides.recordingUrl ?? null,
    })
    .returning({ id: tasks.id });
  if (created === undefined) throw new Error('the fixture task was not created');
  return created.id;
}

async function addEvent(taskId: string, type: 'transition' | 'step', payload: unknown): Promise<void> {
  await app.db.insert(taskEvents).values({ taskId, type, payload });
}

function code(body: string): string {
  return (JSON.parse(body) as { error: { code: string } }).error.code;
}

describe('GET /tasks/:id', () => {
  it('returns the row with its trail oldest first and a reference to its recording', async () => {
    const id = await createTask(ownerId, { recordingUrl: `${storeUrl}/plain` });
    await addEvent(id, 'transition', { from: 'queued', to: 'running', cause: 'started' });
    await addEvent(id, 'step', { name: 'open_site', outcome: 'ok' });
    await addEvent(id, 'transition', { from: 'running', to: 'succeeded', cause: 'finished' });

    const response = await app.inject({ method: 'GET', url: `/tasks/${id}`, headers: as(ownerId) });

    expect(response.statusCode).toBe(200);
    const detail = response.json<TaskDetail>();
    expect(detail).toMatchObject({
      id,
      status: 'succeeded',
      recording: { available: true, href: `/tasks/${id}/recording` },
    });
    expect(detail.events.map((event) => event.type)).toEqual(['transition', 'step', 'transition']);
    expect(detail.events[0]?.payload).toEqual({ from: 'queued', to: 'running', cause: 'started' });
    const seqs = detail.events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    for (const event of detail.events) {
      expect(Number.isNaN(Date.parse(event.ts))).toBe(false);
    }
  });

  it('says a task without a recording has none, and a task without a trail has an empty one', async () => {
    const id = await createTask(ownerId, { status: 'queued' });

    const response = await app.inject({ method: 'GET', url: `/tasks/${id}`, headers: as(ownerId) });

    expect(response.statusCode).toBe(200);
    const detail = response.json<TaskDetail>();
    expect(detail.events).toEqual([]);
    expect(detail.recording).toEqual({ available: false });
  });
});

describe('GET /tasks/:id/recording', () => {
  it.each(['plain', 'gzip', 'raw-gzip'])(
    'serves the recording as NDJSON when the store sent it %s',
    async (shape) => {
      const id = await createTask(ownerId, { recordingUrl: `${storeUrl}/${shape}` });

      const response = await app.inject({
        method: 'GET',
        url: `/tasks/${id}/recording`,
        headers: as(ownerId),
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/^application\/x-ndjson/u);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.body).toBe(RECORDING);
    },
  );

  it('answers a stranger, an unknown id and a task without a recording alike, without asking the store', async () => {
    const strangers = await createTask(strangerId, { recordingUrl: `${storeUrl}/plain` });
    const bare = await createTask(ownerId);
    const unknownId = '00000000-0000-4000-8000-000000000000';

    const asStranger = await app.inject({
      method: 'GET',
      url: `/tasks/${strangers}/recording`,
      headers: as(ownerId),
    });
    const unknown = await app.inject({
      method: 'GET',
      url: `/tasks/${unknownId}/recording`,
      headers: as(ownerId),
    });
    const none = await app.inject({ method: 'GET', url: `/tasks/${bare}/recording`, headers: as(ownerId) });

    expect([asStranger.statusCode, unknown.statusCode, none.statusCode]).toEqual([404, 404, 404]);
    expect([code(asStranger.body), code(unknown.body), code(none.body)]).toEqual([
      'not_found',
      'not_found',
      'not_found',
    ]);
    expect(storeHits).toEqual([]);
  });

  it('reports a store that refuses or cannot be reached as an upstream failure, not as a recording', async () => {
    const refused = await createTask(ownerId, { recordingUrl: `${storeUrl}/missing` });
    const unreachable = await createTask(ownerId, { recordingUrl: `${deadStoreUrl}/plain` });

    const refusedResponse = await app.inject({
      method: 'GET',
      url: `/tasks/${refused}/recording`,
      headers: as(ownerId),
    });
    const unreachableResponse = await app.inject({
      method: 'GET',
      url: `/tasks/${unreachable}/recording`,
      headers: as(ownerId),
    });

    expect(refusedResponse.statusCode).toBe(502);
    expect(code(refusedResponse.body)).toBe('upstream_unavailable');
    expect(unreachableResponse.statusCode).toBe(502);
    expect(code(unreachableResponse.body)).toBe('upstream_unavailable');
    expect(storeHits).toEqual(['/missing']);
  });
});
