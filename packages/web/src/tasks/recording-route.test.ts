import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET as readRecording } from '../app/tasks/[id]/recording/route';
import { SESSION_COOKIE_NAME } from '../auth/session';

/**
 * The recording route's handler, proven here rather than only in the browser.
 *
 * `task-detail-page.integration.test.ts` drives this route for real: a player
 * that fetches through it, plays what it got, and shows an error state when
 * the store let it down. That is the proof it works. This is the proof of the
 * parts a browser cannot see - the exact request the API receives, and every
 * exit being a status rather than a throw - which run in the dashboard's own
 * process and so are instrumented nowhere else.
 */

const API_BASE_URL = 'http://api.test';
const TASK_ID = '3b6f0d4e-9f0a-4b8c-8f4e-1c2d3e4f5a6b';
const SESSION = `${SESSION_COOKIE_NAME}=signed.value`;
const RECORDING = '{"type":4,"data":{},"timestamp":1}\n{"type":2,"data":{},"timestamp":2}\n';

interface Recorded {
  readonly url: string;
  readonly accept: string | undefined;
  readonly cookie: string | undefined;
}

function stubApi(answer: () => Promise<Response>): Recorded[] {
  const calls: Recorded[] = [];
  vi.stubEnv('API_BASE_URL', API_BASE_URL);
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, accept: headers['accept'], cookie: headers['cookie'] });
    return answer();
  });
  return calls;
}

function envelope(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function call(): Promise<Response> {
  const request = new Request(`http://dashboard.test/tasks/${TASK_ID}/recording`, {
    headers: { cookie: SESSION },
  });
  return readRecording(request, { params: Promise.resolve({ id: TASK_ID }) });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('GET /tasks/[id]/recording', () => {
  it("asks the API as the browser's own session and hands the NDJSON through", async () => {
    const calls = stubApi(() =>
      Promise.resolve(
        new Response(RECORDING, {
          status: 200,
          headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
        }),
      ),
    );

    const response = await call();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.text()).toBe(RECORDING);
    expect(calls).toEqual([
      { url: `${API_BASE_URL}/tasks/${TASK_ID}/recording`, accept: 'application/x-ndjson', cookie: SESSION },
    ]);
  });

  it("passes the API's refusal through with its status, as a sentence the player can show", async () => {
    stubApi(() =>
      Promise.resolve(
        envelope(502, 'upstream_unavailable', 'The recording could not be fetched from its store.'),
      ),
    );

    const response = await call();

    expect(response.status).toBe(502);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.text()).toBe('The recording could not be fetched from its store.');
  });

  it('answers a task the API does not know, or one without a recording, with its 404', async () => {
    stubApi(() => Promise.resolve(envelope(404, 'not_found', 'Task has no recording.')));

    const response = await call();

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Task has no recording.');
  });

  it('answers an API that did not answer as 502 rather than as a stack', async () => {
    stubApi(() => Promise.reject(new TypeError('fetch failed')));

    const response = await call();

    expect(response.status).toBe(502);
    expect(await response.text()).toBe('the API did not answer');
  });
});
