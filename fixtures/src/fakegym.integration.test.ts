import { afterEach, describe, expect, it } from 'vitest';

import { type CancellationRefusal, startFakegymFixture } from './fakegym.js';
import { assertNoLeakedFixtures } from './harness.js';

afterEach(() => {
  assertNoLeakedFixtures();
});

const MEMBER = {
  id: 'm-1',
  email: 'aarav@example.com',
  password: 'correct-horse',
  name: 'Aarav',
} as const;

/**
 * A cookie-carrying client. The cancellation flow holds its progress in the
 * session rather than in the URL, so a proof that the flow was actually
 * traversed needs a client that keeps the cookie across requests.
 */
class GymClient {
  private readonly cookies = new Map<string, string>();

  constructor(private readonly base: string) {}

  async get(path: string): Promise<Response> {
    return this.send(path, { method: 'GET' });
  }

  async post(path: string, form: Record<string, string> = {}): Promise<Response> {
    return this.send(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
  }

  private async send(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) {
      headers.set('cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    }
    const response = await fetch(`${this.base}${path}`, {
      ...init,
      headers,
      redirect: 'manual',
    });
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(';')[0] ?? '';
      const split = pair.indexOf('=');
      if (split > 0) {
        this.cookies.set(pair.slice(0, split), pair.slice(split + 1));
      }
    }
    return response;
  }
}

const REACHABLE_PATHS = [
  '/',
  '/login',
  '/member',
  '/cancel/step-1',
  '/cancel/step-2',
  '/cancel/step-3',
  '/cancel/confirm',
];

async function walkToCodeGate(client: GymClient): Promise<void> {
  await client.post('/login', { email: MEMBER.email, password: MEMBER.password });
  await client.post('/cancel/step-1', { choice: 'continue' });
  await client.post('/cancel/step-2', { choice: 'continue' });
  await client.post('/cancel/step-3', { choice: 'continue' });
}

async function payload(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('fakegym cancellation', () => {
  it('reaches cancelled only by traversing every step and supplying the emailed code', async () => {
    const gym = await startFakegymFixture();
    try {
      await gym.control.seedMember(MEMBER);
      const client = new GymClient(gym.url);

      await walkToCodeGate(client);
      const code = await gym.control.confirmationCode(MEMBER.id);
      const response = await client.post('/cancel/confirm', { code });

      expect(response.status).toBe(200);
      expect(await payload(response)).toMatchObject({ status: 'cancelled' });
      expect(await gym.control.member(MEMBER.id)).toMatchObject({ status: 'cancelled' });
    } finally {
      await gym.stop();
    }
  });

  it('never puts the confirmation code on a reachable page or in a response body', async () => {
    const gym = await startFakegymFixture();
    try {
      await gym.control.seedMember(MEMBER);
      const code = await gym.control.confirmationCode(MEMBER.id);
      const client = new GymClient(gym.url);

      const bodies: string[] = [];
      bodies.push(await (await client.post('/login', { email: MEMBER.email, password: MEMBER.password })).text());
      for (const step of ['/cancel/step-1', '/cancel/step-2', '/cancel/step-3']) {
        bodies.push(await (await client.get(step)).text());
        bodies.push(await (await client.post(step, { choice: 'continue' })).text());
      }
      for (const path of REACHABLE_PATHS) {
        bodies.push(await (await client.get(path)).text());
      }
      bodies.push(await (await client.post('/cancel/confirm', { code: 'GYM-000000' })).text());
      bodies.push(JSON.stringify(await gym.control.member(MEMBER.id)));

      expect(code).toMatch(/^GYM-\d{6}$/);
      for (const [index, seen] of bodies.entries()) {
        expect(seen, `body ${index} must not leak the code`).not.toContain(code);
      }
    } finally {
      await gym.stop();
    }
  });

  it('refuses the code gate to a session that skipped the earlier steps', async () => {
    const gym = await startFakegymFixture();
    try {
      await gym.control.seedMember(MEMBER);
      const code = await gym.control.confirmationCode(MEMBER.id);
      const client = new GymClient(gym.url);
      await client.post('/login', { email: MEMBER.email, password: MEMBER.password });

      const response = await client.post('/cancel/confirm', { code });

      expect(await payload(response)).toMatchObject({
        code: 'step-skipped' satisfies CancellationRefusal,
      });
      expect(await gym.control.member(MEMBER.id)).toMatchObject({ status: 'active' });
    } finally {
      await gym.stop();
    }
  });

  it('refuses a later step to a session that skipped an earlier one', async () => {
    const gym = await startFakegymFixture();
    try {
      await gym.control.seedMember(MEMBER);
      const client = new GymClient(gym.url);
      await client.post('/login', { email: MEMBER.email, password: MEMBER.password });

      const response = await client.post('/cancel/step-3', { choice: 'continue' });

      expect(await payload(response)).toMatchObject({ code: 'step-skipped' });
      expect(await gym.control.member(MEMBER.id)).toMatchObject({ status: 'active' });
    } finally {
      await gym.stop();
    }
  });

  it.each([
    ['a wrong code', 'GYM-999999'],
    ['an absent code', ''],
  ])('refuses %s with a typed reason that is not a retry hint', async (_label, code) => {
    const gym = await startFakegymFixture();
    try {
      await gym.control.seedMember(MEMBER);
      const client = new GymClient(gym.url);
      await walkToCodeGate(client);

      const response = await client.post('/cancel/confirm', { code });
      const refusal = await payload(response);

      expect(refusal).toMatchObject({ code: 'wrong-code' satisfies CancellationRefusal });
      expect(refusal.retryable).toBeUndefined();
      expect(response.status).toBeLessThan(500);
      expect(await gym.control.member(MEMBER.id)).toMatchObject({ status: 'active' });
    } finally {
      await gym.stop();
    }
  });

  it('lands retained, not cancelled, when the retention offer is accepted', async () => {
    const gym = await startFakegymFixture();
    try {
      await gym.control.seedMember(MEMBER);
      const client = new GymClient(gym.url);
      await client.post('/login', { email: MEMBER.email, password: MEMBER.password });

      await client.post('/cancel/step-1', { choice: 'keep' });

      expect(await gym.control.member(MEMBER.id)).toMatchObject({ status: 'retained' });
      const blocked = await client.post('/cancel/step-2', { choice: 'continue' });
      expect(await payload(blocked)).toMatchObject({ code: 'step-skipped' });
    } finally {
      await gym.stop();
    }
  });

  it('treats cancelling an already-cancelled member as idempotent rather than an error', async () => {
    const gym = await startFakegymFixture();
    try {
      await gym.control.seedMember(MEMBER);
      const code = await gym.control.confirmationCode(MEMBER.id);

      const first = new GymClient(gym.url);
      await walkToCodeGate(first);
      await first.post('/cancel/confirm', { code });

      const second = new GymClient(gym.url);
      await second.post('/login', { email: MEMBER.email, password: MEMBER.password });
      const response = await second.post('/cancel/confirm', { code });

      expect(response.status).toBe(200);
      expect(await payload(response)).toMatchObject({ status: 'cancelled' });
      expect(await gym.control.member(MEMBER.id)).toMatchObject({ status: 'cancelled' });
    } finally {
      await gym.stop();
    }
  });

  it('redirects an unauthenticated visitor to login instead of erroring', async () => {
    const gym = await startFakegymFixture();
    try {
      await gym.control.seedMember(MEMBER);
      const client = new GymClient(gym.url);

      for (const path of ['/member', '/cancel/step-1', '/cancel/confirm']) {
        const response = await client.get(path);
        expect(response.status, path).toBe(302);
        expect(response.headers.get('location'), path).toBe('/login');
      }
    } finally {
      await gym.stop();
    }
  });

  it('refuses an unauthenticated cancellation post as unauthenticated', async () => {
    const gym = await startFakegymFixture();
    try {
      await gym.control.seedMember(MEMBER);
      const client = new GymClient(gym.url);

      const response = await client.post('/cancel/confirm', { code: 'GYM-000000' });

      expect(await payload(response)).toMatchObject({
        code: 'unauthenticated' satisfies CancellationRefusal,
      });
      expect(await gym.control.member(MEMBER.id)).toMatchObject({ status: 'active' });
    } finally {
      await gym.stop();
    }
  });

  it('refuses wrong credentials without opening a session', async () => {
    const gym = await startFakegymFixture();
    try {
      await gym.control.seedMember(MEMBER);
      const client = new GymClient(gym.url);

      const login = await client.post('/login', { email: MEMBER.email, password: 'wrong' });
      expect(login.status).toBe(401);

      const member = await client.get('/member');
      expect(member.status).toBe(302);
    } finally {
      await gym.stop();
    }
  });

  it('gives the member area an accessible name and hooks for every control', async () => {
    const gym = await startFakegymFixture();
    try {
      await gym.control.seedMember(MEMBER);
      const client = new GymClient(gym.url);
      await client.post('/login', { email: MEMBER.email, password: MEMBER.password });

      const area = await (await client.get('/member')).text();
      expect(area).toContain('data-testid="member-status"');
      expect(area).toContain('data-testid="start-cancellation"');
      expect(area).toContain(MEMBER.name);

      const gate = await (await client.get('/cancel/step-1')).text();
      expect(gate).toContain('data-testid="keep-membership"');
      expect(gate).toContain('data-testid="continue-cancellation"');
    } finally {
      await gym.stop();
    }
  });

  it('keeps two instances independent', async () => {
    const a = await startFakegymFixture();
    const b = await startFakegymFixture();
    try {
      await a.control.seedMember(MEMBER);
      await b.control.seedMember(MEMBER);

      const client = new GymClient(a.url);
      await walkToCodeGate(client);
      await client.post('/cancel/confirm', { code: await a.control.confirmationCode(MEMBER.id) });

      expect(await a.control.member(MEMBER.id)).toMatchObject({ status: 'cancelled' });
      expect(await b.control.member(MEMBER.id)).toMatchObject({ status: 'active' });
    } finally {
      await a.stop();
      await b.stop();
    }
  });
});
