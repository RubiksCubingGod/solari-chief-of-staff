import { afterEach, describe, expect, it, vi } from 'vitest';

import { POST as cancel } from '../app/connect/[id]/cancel/route';
import { POST as confirm } from '../app/connect/[id]/confirm/route';
import { POST as start } from '../app/connect/start/route';
import { SESSION_COOKIE_NAME } from '../auth/session';
import { connectPathWithOutcome } from './connect-outcome';

/**
 * The three connect controls' handlers, proven here rather than only in a
 * browser: what each asks the API, what each refuses before asking, and where
 * each sends the reader when the API refuses or does not answer. Like the pause
 * control, every exit is a 303 carrying a token - a route that throws renders
 * Next's default 500 on the one button the reader pressed.
 */

const API_BASE_URL = 'http://api.test';
const ATTEMPT_ID = 'attempt-1';
const SESSION = `${SESSION_COOKIE_NAME}=signed.value`;

interface Recorded {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: string | undefined;
  readonly cookie: string | undefined;
}

function recording(answer: () => Response): Recorded[] {
  const calls: Recorded[] = [];
  vi.stubEnv('API_BASE_URL', API_BASE_URL);
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init?.method,
      body: typeof init?.body === 'string' ? init.body : undefined,
      cookie: headers['cookie'],
    });
    return Promise.resolve(answer());
  });
  return calls;
}

/** The API answering an attempt, as `POST /site-connections/attempts` does. */
function stubApi(status = 201): Recorded[] {
  return recording(
    () =>
      new Response(JSON.stringify({ id: ATTEMPT_ID, status: 'started' }), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

function stubApiRefusing(status: number, code: string, message: string): Recorded[] {
  return recording(
    () =>
      new Response(JSON.stringify({ error: { code, message, details: [] } }), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

function stubApiUnreachable(): void {
  vi.stubEnv('API_BASE_URL', API_BASE_URL);
  vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
}

function submit(path: string, fields: Record<string, string>, cookie: string | null = SESSION): Request {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  return new Request(`https://dashboard.test${path}`, {
    method: 'POST',
    body: form,
    ...(cookie === null ? {} : { headers: { cookie } }),
  });
}

const forAttempt = { params: Promise.resolve({ id: ATTEMPT_ID }) };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('POST /connect/start', () => {
  it('asks the API for an attempt on that domain and sends the reader to it, carrying the session unread', async () => {
    const calls = stubApi();

    const response = await start(submit('/connect/start', { siteDomain: 'gym.example.test' }));

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`${API_BASE_URL}/site-connections/attempts`);
    expect(calls[0]?.body).toBe('{"siteDomain":"gym.example.test"}');
    expect(calls[0]?.cookie).toBe(SESSION);
    expect(response.status).toBe(303);
    // The attempt page, where the console link and the confirm button are.
    expect(response.headers.get('location')).toBe(`/connect/${ATTEMPT_ID}`);
  });

  it('trims and lowercases what the reader typed, since a host is neither spaced nor cased', async () => {
    const calls = stubApi();

    await start(submit('/connect/start', { siteDomain: '  Gym.Example.Test ' }));

    expect(calls[0]?.body).toBe('{"siteDomain":"gym.example.test"}');
  });

  it('escapes an id the API hands back before putting it in a path', async () => {
    recording(
      () =>
        new Response(JSON.stringify({ id: 'a/b', status: 'started' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const response = await start(submit('/connect/start', { siteDomain: 'gym.example.test' }));

    expect(response.headers.get('location')).toBe('/connect/a%2Fb');
  });

  it('asks the API nothing when the form carries no domain', async () => {
    const calls = stubApi();

    for (const form of [submit('/connect/start', {}), submit('/connect/start', { siteDomain: '   ' })]) {
      const response = await start(form);
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe(connectPathWithOutcome('rejected'));
    }

    expect(calls).toEqual([]);
  });

  it('says the feature is not switched on when the API has no vendor to ask', async () => {
    stubApiRefusing(503, 'upstream_unavailable', 'SOLARI_API_KEY is not set on the server.');

    const response = await start(submit('/connect/start', { siteDomain: 'gym.example.test' }));

    // Its own outcome, because the reader's next move is different: nothing
    // they type will help, and an operator has to set a key.
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(connectPathWithOutcome('unavailable'));
  });

  it('returns the reader to the list when the API refuses the domain', async () => {
    stubApiRefusing(400, 'validation_failed', 'The request did not match the schema.');

    const response = await start(submit('/connect/start', { siteDomain: 'gym.example.test' }));

    expect(response.headers.get('location')).toBe(connectPathWithOutcome('failed'));
  });

  it('returns the reader to the list when the API could not be reached at all', async () => {
    stubApiUnreachable();

    const response = await start(submit('/connect/start', { siteDomain: 'gym.example.test' }));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(connectPathWithOutcome('failed'));
  });

  it('sends an unauthenticated post on to the API rather than deciding for it', async () => {
    const calls = stubApi();

    await start(submit('/connect/start', { siteDomain: 'gym.example.test' }, null));

    expect(calls[0]?.cookie).toBe('');
  });

  it('lets a defect in this process out rather than dressing it as a refusal', async () => {
    vi.stubEnv('API_BASE_URL', API_BASE_URL);
    vi.stubGlobal('fetch', () => Promise.resolve(undefined));

    await expect(start(submit('/connect/start', { siteDomain: 'gym.example.test' }))).rejects.toThrow(
      TypeError,
    );
  });
});

describe('POST /connect/[id]/confirm', () => {
  it('confirms that attempt with the API and sends the reader to the list as connected', async () => {
    const calls = stubApi(200);

    const response = await confirm(submit(`/connect/${ATTEMPT_ID}/confirm`, {}), forAttempt);

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`${API_BASE_URL}/site-connections/attempts/${ATTEMPT_ID}/confirm`);
    expect(calls[0]?.cookie).toBe(SESSION);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(connectPathWithOutcome('connected'));
  });

  it('escapes the id from the path before putting it in another', async () => {
    const calls = stubApi(200);

    await confirm(submit('/connect/a%2Fb/confirm', {}), { params: Promise.resolve({ id: 'a/b' }) });

    expect(calls[0]?.url).toBe(`${API_BASE_URL}/site-connections/attempts/a%2Fb/confirm`);
  });

  it('sends an unauthenticated post on to the API rather than deciding for it', async () => {
    const calls = stubApi(200);

    await confirm(submit(`/connect/${ATTEMPT_ID}/confirm`, {}, null), forAttempt);

    expect(calls[0]?.cookie).toBe('');
  });

  it('returns the reader to the list when the attempt is no longer open', async () => {
    stubApiRefusing(404, 'not_found', 'That attempt is not open.');

    const response = await confirm(submit(`/connect/${ATTEMPT_ID}/confirm`, {}), forAttempt);

    expect(response.headers.get('location')).toBe(connectPathWithOutcome('failed'));
  });

  it('returns the reader to the list when the API could not be reached at all', async () => {
    stubApiUnreachable();

    const response = await confirm(submit(`/connect/${ATTEMPT_ID}/confirm`, {}), forAttempt);

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(connectPathWithOutcome('failed'));
  });
});

describe('POST /connect/[id]/cancel', () => {
  it('cancels that attempt with the API and sends the reader to the list as cancelled', async () => {
    const calls = recording(() => new Response(null, { status: 204 }));

    const response = await cancel(submit(`/connect/${ATTEMPT_ID}/cancel`, {}), forAttempt);

    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url).toBe(`${API_BASE_URL}/site-connections/attempts/${ATTEMPT_ID}`);
    expect(calls[0]?.cookie).toBe(SESSION);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(connectPathWithOutcome('cancelled'));
  });

  it('sends an unauthenticated post on to the API rather than deciding for it', async () => {
    const calls = recording(() => new Response(null, { status: 204 }));

    await cancel(submit(`/connect/${ATTEMPT_ID}/cancel`, {}, null), forAttempt);

    expect(calls[0]?.cookie).toBe('');
  });

  it('returns the reader to the list when the API refuses', async () => {
    stubApiRefusing(404, 'not_found', 'That attempt is not open.');

    const response = await cancel(submit(`/connect/${ATTEMPT_ID}/cancel`, {}), forAttempt);

    expect(response.headers.get('location')).toBe(connectPathWithOutcome('failed'));
  });
});
