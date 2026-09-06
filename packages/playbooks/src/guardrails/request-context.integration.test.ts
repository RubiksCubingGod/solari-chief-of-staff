import { createServer, type Server } from 'node:http';

import { createLocalProvider, type BrowserProvider } from '@chief-of-staff/solari';
import type { Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { guardedSession, type GuardedRun, type GuardrailPolicy } from './guardrails.js';

/**
 * The guard on Playwright's other door. Every request the browser makes is
 * routed and judged; a request made from Node through `page.request` or
 * `context.request` is not a browser request at all, and no route handler
 * ever sees it. The site here answers to two names, so "outside the lane"
 * is the same server reached as `localhost`, and whichever name a request
 * used, the site logs it: the proof can see whether a refused request
 * arrived. No database is involved; this is the guard and a browser.
 */
let provider: BrowserProvider;
let server: Server;
let hits: string[] = [];
let lane = '';
let away = '';

const policy: GuardrailPolicy = { allowlist: ['127.0.0.1'] };

beforeAll(async () => {
  server = createServer((request, response) => {
    hits.push(`${request.method ?? ''} ${request.url ?? ''}`);
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<!doctype html><title>Lane</title><h1>Lane</h1>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the lane did not bind a port');
  lane = `http://127.0.0.1:${String(address.port)}`;
  away = `http://localhost:${String(address.port)}`;
  provider = createLocalProvider();
});

afterAll(async () => {
  await provider.dispose();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
});

beforeEach(() => {
  hits = [];
});

/** A guarded run that lands inside the lane first, then does what the step asks. */
function attempt(step: (page: Page) => Promise<unknown>): Promise<GuardedRun<'reached'>> {
  return guardedSession({ provider, policy }, async (page) => {
    await page.goto(`${lane}/`);
    await step(page);
    return 'reached' as const;
  });
}

function requestContextStop(attemptedUrl: string): GuardedRun<'reached'>['outcome'] {
  return {
    kind: 'stopped',
    stop: {
      kind: 'allowlist',
      attemptedUrl,
      via: 'request-context',
      redirectedFrom: undefined,
      from: `${lane}/`,
      reason: 'unguarded',
    },
  };
}

describe('the request contexts', () => {
  it("stops a step that reaches out through the page's request context, before the site sees it", async () => {
    const run = await attempt((page) => page.request.get(`${away}/exfil`));
    expect(run.outcome).toEqual(requestContextStop(`${away}/exfil`));
    expect(hits).toEqual(['GET /']);
  });

  it("stops a post through the context's request context even inside the lane, and the site never sees the body", async () => {
    const run = await attempt((page) =>
      page.context().request.post(`${lane}/pay`, { form: { cardnumber: '4242424242424242', cvc: '123' } }),
    );
    expect(run.outcome).toEqual(requestContextStop(`${lane}/pay`));
    expect(hits).toEqual(['GET /']);
  });
});
