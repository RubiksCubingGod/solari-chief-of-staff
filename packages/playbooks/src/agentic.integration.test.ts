import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { StepEventPayload } from '@chief-of-staff/core';
import {
  mountInstanceRoutes,
  startFakegymFixture,
  startFixture,
  type FakegymControl,
  type FixtureHandle,
} from '@chief-of-staff/fixtures';
import { createLocalProvider, withBrowser, type BrowserProvider } from '@chief-of-staff/solari';
import type { Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createBrowserToolset,
  type BrowserToolset,
  type DigestElement,
  type PageDigest,
  type ToolExecution,
} from './agentic/index.js';
import { guardedSession, installGuardrails, type Guardrails } from './guardrails/index.js';

/**
 * The toolset on the real substrate: a local Chromium behind the s5 guard,
 * pages served by a test-local workshop site and by the fakegym fixture. The
 * unit tests prove the pure rules (bounding, rendering, schemas); this proves
 * what only a browser can: that the digest sees what a person sees, that the
 * refs it hands out survive a rebuild and go stale honestly, that every tool
 * acts on the page and answers in type, and that a navigate the guard refuses
 * comes back as a violation rather than as a crash.
 */

const MEMBER = {
  id: 'm-toolset',
  email: 'toolset@example.test',
  password: 'correct horse',
  name: 'Toolset Member',
};

interface WorkshopState {
  readonly posts: readonly Record<string, string>[];
}

interface WorkshopControl {
  state(): Promise<WorkshopState>;
  reset(): Promise<WorkshopState>;
}

function html(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A site with everything a digest has to see on one page, and the shapes the
 * tools have to fail on: a disabled button, a covered button, a link outside
 * the lane, a form whose echo page shows what was actually submitted.
 * "Outside" is the same server by another name, so no second port is needed.
 */
function startWorkshop(): Promise<FixtureHandle<WorkshopControl>> {
  let posts: Record<string, string>[] = [];
  return startFixture(
    'workshop',
    (app) => {
      app.use((request, _response, next) => {
        // Express's JSON parser is already mounted; forms need the urlencoded one.
        if (request.is('application/x-www-form-urlencoded')) {
          let raw = '';
          request.setEncoding('utf8');
          request.on('data', (chunk: string) => {
            raw += chunk;
          });
          request.on('end', () => {
            request.body = Object.fromEntries(new URLSearchParams(raw));
            next();
          });
          return;
        }
        next();
      });
      mountInstanceRoutes<WorkshopState>(app, {
        state: () => ({ posts }),
        seed: () => undefined,
        reset: () => {
          posts = [];
        },
      });
      app.get('/', (request, response) => {
        const away = `http://localhost:${String(request.socket.localPort)}`;
        response.type('html').send(
          html(
            'Workshop',
            [
              '<h1>Workshop</h1>',
              '<p>Everything a digest has to see, on <em>one</em> page.</p>',
              '<nav><a href="/members">Members</a> ',
              `<a href="${away}/partner">Partner site</a> `,
              '<a href="/"><img src="data:," alt="Workshop home"></a></nav>',
              '<div style="display:none"><a href="/secret">Hidden link</a></div>',
              '<form method="post" action="/echo">',
              '<label for="email">Email address</label><input id="email" name="email" type="email">',
              '<input name="q" type="search" aria-label="Search the workshop">',
              '<input name="nickname" placeholder="Nickname">',
              '<label>Plan <select name="plan"><option value="monthly">Monthly</option><option value="annual" selected>Annual</option></select></label>',
              '<label><input type="checkbox" name="remember"> Remember me</label>',
              '<span id="notes-label">Notes for the team</span><textarea name="notes" aria-labelledby="notes-label"></textarea>',
              '<input type="password" name="secret" aria-label="Secret" value="hunter2">',
              '<button type="button" disabled>Locked</button>',
              '<input type="submit" value="Send it">',
              '</form>',
              '<div role="alert">Unsaved changes</div>',
            ].join(''),
          ),
        );
      });
      app.get('/members', (_request, response) => {
        response
          .type('html')
          .send(html('Members', '<h1>Members area</h1><a href="/">Back to the workshop</a>'));
      });
      app.get('/covered', (_request, response) => {
        response.type('html').send(
          html(
            'Covered',
            '<button type="button">Under the overlay</button>' +
              '<div style="position:fixed;inset:0;background:rgba(0,0,0,.2)"></div>',
          ),
        );
      });
      app.get('/crowd', (_request, response) => {
        const links = Array.from(
          { length: 300 },
          (_, index) => `<a href="/crowd/${String(index)}">Link ${String(index)}</a>`,
        );
        const paragraphs = Array.from(
          { length: 120 },
          (_, index) => `<p>Paragraph ${String(index)} ${'word '.repeat(90)}</p>`,
        );
        response.type('html').send(html('Crowd', [...links, ...paragraphs].join('')));
      });
      app.post('/echo', (request, response) => {
        const fields = request.body as Record<string, string>;
        posts.push(fields);
        const items = Object.entries(fields)
          .map(([key, value]) => `<li>${escape(key)}: ${escape(value)}</li>`)
          .join('');
        response.type('html').send(html('Received', `<h1>Received</h1><ul>${items}</ul>`));
      });
    },
    (request) => ({
      state: () => request<WorkshopState>('GET', '/__test/state'),
      reset: () => request<WorkshopState>('POST', '/__test/reset'),
    }),
  );
}

/** The same server reached by a name the allowlist does not carry. */
function away(url: string): string {
  return url.replace('127.0.0.1', 'localhost');
}

/** A loopback port nothing listens on, for a navigation that has to fail on the wire. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

let workshop: FixtureHandle<WorkshopControl>;
let gym: FixtureHandle<FakegymControl>;
let provider: BrowserProvider;

beforeAll(async () => {
  [workshop, gym] = await Promise.all([startWorkshop(), startFakegymFixture()]);
  await gym.control.seedMember(MEMBER);
  await gym.control.seed({});
  provider = createLocalProvider();
});

afterEach(async () => {
  await workshop.control.reset();
  await gym.control.reset();
  expect(provider.liveSessionIds()).toEqual([]);
});

afterAll(async () => {
  await provider.dispose();
  await Promise.all([workshop.stop(), gym.stop()]);
});

interface Bench {
  readonly toolset: BrowserToolset;
  readonly page: Page;
  readonly guard: Guardrails;
  readonly trail: StepEventPayload[];
}

/** A guarded page with the toolset over it, allowed onto both sites. */
function bench<T>(body: (bench: Bench) => Promise<T>): Promise<T> {
  return withBrowser(provider, { recording: true }, async (session) => {
    const guard = await installGuardrails(session.context, { allowlist: ['127.0.0.1'] });
    const page = await session.newPage();
    const trail: StepEventPayload[] = [];
    const toolset = createBrowserToolset({
      page,
      guard,
      log: (payload) => {
        trail.push(payload);
        return Promise.resolve();
      },
      actionTimeoutMs: 1_500,
      navigationTimeoutMs: 30_000,
    });
    return body({ toolset, page, guard, trail });
  });
}

function ok(execution: ToolExecution): Extract<ToolExecution, { kind: 'ok' }> {
  if (execution.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(execution)}`);
  return execution;
}

function digestOf(execution: ToolExecution): PageDigest {
  const result = ok(execution).result;
  if (result.kind !== 'digest') throw new Error(`expected a digest, got ${result.kind}`);
  return result.digest;
}

function failure(execution: ToolExecution): Extract<ToolExecution, { kind: 'error' }>['failure'] {
  if (execution.kind !== 'error') throw new Error(`expected error, got ${JSON.stringify(execution)}`);
  return execution.failure;
}

function find(digest: PageDigest, label: string, kind?: DigestElement['kind']): DigestElement {
  const element = digest.elements.find(
    (candidate) => candidate.label === label && (kind === undefined || candidate.kind === kind),
  );
  if (element === undefined) {
    throw new Error(`no ${kind ?? 'element'} labelled "${label}" in ${JSON.stringify(digest.elements)}`);
  }
  return element;
}

describe('the page digest', () => {
  it('sees what a person sees: labels, kinds, values, and nothing hidden', async () => {
    await bench(async ({ toolset }) => {
      const digest = digestOf(await toolset.execute('navigate', { url: `${workshop.url}/` }));

      expect(digest.title).toBe('Workshop');
      expect(digest.url).toBe(`${workshop.url}/`);
      expect(find(digest, 'Members', 'link').href).toBe(`${workshop.url}/members`);
      expect(find(digest, 'Workshop home', 'link').href).toBe(`${workshop.url}/`);
      expect(find(digest, 'Email address', 'textbox')).toMatchObject({
        name: 'email',
        inputType: 'email',
        value: '',
      });
      expect(find(digest, 'Search the workshop', 'textbox').inputType).toBe('search');
      expect(find(digest, 'Nickname', 'textbox').name).toBe('nickname');
      expect(find(digest, 'Plan', 'select').options).toEqual([
        { value: 'monthly', label: 'Monthly', selected: false },
        { value: 'annual', label: 'Annual', selected: true },
      ]);
      expect(find(digest, 'Remember me', 'checkbox').checked).toBe(false);
      expect(find(digest, 'Notes for the team', 'textarea').name).toBe('notes');
      expect(find(digest, 'Locked', 'button').disabled).toBe(true);
      expect(find(digest, 'Send it', 'button')).toMatchObject({ inputType: 'submit' });

      const secret = find(digest, 'Secret', 'textbox');
      expect(secret.inputType).toBe('password');
      expect(secret.value).toBeUndefined();
      expect(ok(await toolset.execute('read', {})).text).not.toContain('hunter2');

      expect(digest.elements.map((element) => element.label)).not.toContain('Hidden link');
      expect(digest.regions).toContainEqual({ role: 'heading', text: 'Workshop' });
      expect(digest.regions).toContainEqual({
        role: 'text',
        text: 'Everything a digest has to see, on one page.',
      });
      expect(digest.regions).toContainEqual({ role: 'alert', text: 'Unsaved changes' });
      expect(digest.regions.map((region) => region.text)).not.toContain('Email address');
      expect(digest.truncation).toEqual({ elementsOmitted: 0, regionsOmitted: 0, clipped: false });
    });
  });

  it('hands out the same refs for an unchanged page, in document order', async () => {
    await bench(async ({ toolset }) => {
      const first = digestOf(await toolset.execute('navigate', { url: `${workshop.url}/` }));
      const second = digestOf(await toolset.execute('read', {}));

      expect(second).toEqual(first);
      expect(first.elements.map((element) => element.ref)).toEqual(
        first.elements.map((_, index) => `e${String(index + 1)}`),
      );
      expect(first.elements[0]?.label).toBe('Members');
    });
  });

  it('never reuses a ref across documents', async () => {
    await bench(async ({ toolset }) => {
      const home = digestOf(await toolset.execute('navigate', { url: `${workshop.url}/` }));
      const members = digestOf(await toolset.execute('navigate', { url: `${workshop.url}/members` }));

      const homeRefs = new Set(home.elements.map((element) => element.ref));
      for (const element of members.elements) expect(homeRefs.has(element.ref)).toBe(false);
      expect(members.elements[0]?.label).toBe('Back to the workshop');
    });
  });

  it('marks what it left out when a page is bigger than the digest', async () => {
    await withBrowser(provider, { recording: true }, async (session) => {
      const guard = await installGuardrails(session.context, { allowlist: ['127.0.0.1'] });
      const page = await session.newPage();
      const toolset = createBrowserToolset({
        page,
        guard,
        log: () => Promise.resolve(),
        limits: { maxElements: 50, maxRegions: 20, maxRegionChars: 100 },
      });

      const crowd = digestOf(await toolset.execute('navigate', { url: `${workshop.url}/crowd` }));

      expect(crowd.elements).toHaveLength(50);
      expect(crowd.regions).toHaveLength(20);
      expect(crowd.truncation).toEqual({ elementsOmitted: 250, regionsOmitted: 100, clipped: true });
      expect(crowd.regions[0]?.text.length).toBeLessThanOrEqual(100);
      expect(crowd.regions[0]?.text.endsWith('…')).toBe(true);
      const text = ok(await toolset.execute('read', {})).text;
      expect(text).toContain('250 more interactive elements');
      expect(text).toContain('100 more text regions');
    });
  });
});

describe('the tools', () => {
  it('fills, selects, ticks and submits a form, and logs every call to the trail', async () => {
    await bench(async ({ toolset, trail }) => {
      const form = digestOf(await toolset.execute('navigate', { url: `${workshop.url}/` }));

      const typed = ok(
        await toolset.execute('type', {
          ref: find(form, 'Email address').ref,
          text: 'someone@example.test',
        }),
      );
      expect(typed.result).toEqual({
        kind: 'field',
        page: { url: `${workshop.url}/`, title: 'Workshop' },
        ref: find(form, 'Email address').ref,
        value: 'someone@example.test',
      });
      expect(typed.text).toContain('Email address');

      const byLabel = ok(await toolset.execute('select', { ref: find(form, 'Plan').ref, option: 'Monthly' }));
      expect(byLabel.result).toMatchObject({ kind: 'field', value: 'Monthly' });
      ok(await toolset.execute('select', { ref: find(form, 'Plan').ref, option: 'annual' }));
      ok(await toolset.execute('select', { ref: find(form, 'Plan').ref, option: 'monthly' }));

      ok(await toolset.execute('click', { ref: find(form, 'Remember me').ref }));
      expect(find(digestOf(await toolset.execute('read', {})), 'Remember me').checked).toBe(true);
      expect(find(digestOf(await toolset.execute('read', {})), 'Email address').value).toBe(
        'someone@example.test',
      );

      const received = digestOf(await toolset.execute('click', { ref: find(form, 'Send it').ref }));
      expect(received.title).toBe('Received');
      expect(received.regions).toContainEqual({ role: 'text', text: 'email: someone@example.test' });
      expect(received.regions).toContainEqual({ role: 'text', text: 'plan: monthly' });
      expect(received.regions).toContainEqual({ role: 'text', text: 'remember: on' });
      expect((await workshop.control.state()).posts).toHaveLength(1);

      expect(trail.map((entry) => [entry.name, entry.outcome])).toEqual([
        ['tool:navigate', 'ok'],
        ['tool:type', 'ok'],
        ['tool:select', 'ok'],
        ['tool:select', 'ok'],
        ['tool:select', 'ok'],
        ['tool:click', 'ok'],
        ['tool:read', 'ok'],
        ['tool:read', 'ok'],
        ['tool:click', 'ok'],
      ]);
      expect(trail[0]?.detail).toEqual({
        input: { url: `${workshop.url}/` },
        result: {
          kind: 'digest',
          url: `${workshop.url}/`,
          title: 'Workshop',
          elements: form.elements.length,
          regions: form.regions.length,
          truncation: { elementsOmitted: 0, regionsOmitted: 0, clipped: false },
        },
      });
      expect(trail[1]?.detail).toEqual({
        input: { ref: find(form, 'Email address').ref, text: 'someone@example.test' },
        result: typed.result,
      });
    });
  });

  it('follows a link with click and comes back with the new page', async () => {
    await bench(async ({ toolset }) => {
      const home = digestOf(await toolset.execute('navigate', { url: `${workshop.url}/` }));
      const members = digestOf(await toolset.execute('click', { ref: find(home, 'Members').ref }));

      expect(members.url).toBe(`${workshop.url}/members`);
      expect(members.regions).toContainEqual({ role: 'heading', text: 'Members area' });
    });
  });

  it('carries ask_user and declare_outcome through as typed endings', async () => {
    await bench(async ({ toolset, trail }) => {
      const ask = await toolset.execute('ask_user', { question: 'What is the code?' });
      expect(ask).toEqual({
        kind: 'ask',
        question: 'What is the code?',
        text: expect.stringContaining('What is the code?') as string,
      });

      const outcome = await toolset.execute('declare_outcome', {
        status: 'succeeded',
        detail: 'The page says cancelled.',
      });
      expect(outcome).toEqual({
        kind: 'outcome',
        status: 'succeeded',
        detail: 'The page says cancelled.',
        text: expect.stringContaining('succeeded') as string,
      });

      expect(trail).toEqual([
        {
          name: 'tool:ask_user',
          outcome: 'ask',
          detail: { input: { question: 'What is the code?' }, question: 'What is the code?' },
        },
        {
          name: 'tool:declare_outcome',
          outcome: 'declared',
          detail: {
            input: { status: 'succeeded', detail: 'The page says cancelled.' },
            status: 'succeeded',
            detail: 'The page says cancelled.',
          },
        },
      ]);
    });
  });

  it('walks fakegym from sign-in to the retention answer with nothing but the tools', async () => {
    await bench(async ({ toolset }) => {
      const login = digestOf(await toolset.execute('navigate', { url: `${gym.url}/login` }));
      ok(await toolset.execute('type', { ref: find(login, 'Email').ref, text: MEMBER.email }));
      ok(await toolset.execute('type', { ref: find(login, 'Password').ref, text: MEMBER.password }));

      const member = digestOf(await toolset.execute('click', { ref: find(login, 'Sign in', 'button').ref }));
      expect(member.url).toBe(`${gym.url}/member`);
      expect(member.regions).toContainEqual({ role: 'text', text: 'active' });

      const offer = digestOf(
        await toolset.execute('click', { ref: find(member, 'Cancel membership', 'link').ref }),
      );
      expect(offer.regions).toContainEqual({ role: 'heading', text: 'Before you go' });

      const answer = digestOf(
        await toolset.execute('click', { ref: find(offer, 'Continue cancelling', 'button').ref }),
      );
      expect(answer.regions.map((region) => region.text).join(' ')).toContain('/cancel/step-2');
    });
  });
});

describe('typed failures', () => {
  it('refuses a tool it does not have and arguments that do not fit', async () => {
    await bench(async ({ toolset, trail }) => {
      expect(failure(await toolset.execute('scroll', {}))).toEqual({ kind: 'unknown-tool', tool: 'scroll' });

      const missing = failure(await toolset.execute('type', { ref: 'e1' }));
      expect(missing.kind).toBe('invalid-arguments');
      if (missing.kind !== 'invalid-arguments') throw new Error('unreachable');
      expect(missing.issues.join(' ')).toContain('text');

      const relative = failure(await toolset.execute('navigate', { url: 'fakegym.com/login' }));
      expect(relative.kind).toBe('invalid-arguments');
      if (relative.kind !== 'invalid-arguments') throw new Error('unreachable');
      expect(relative.issues.join(' ')).toContain('http');

      expect(failure(await toolset.execute('declare_outcome', { status: 'done', detail: 'x' })).kind).toBe(
        'invalid-arguments',
      );
      expect(failure(await toolset.execute('click', { ref: 'button 3' })).kind).toBe('invalid-arguments');

      expect(trail.map((entry) => [entry.name, entry.outcome])).toEqual([
        ['tool:scroll', 'unknown-tool'],
        ['tool:type', 'invalid-arguments'],
        ['tool:navigate', 'invalid-arguments'],
        ['tool:declare_outcome', 'invalid-arguments'],
        ['tool:click', 'invalid-arguments'],
      ]);
    });
  });

  it('calls a ref stale when it was never handed out, left the page, or changed', async () => {
    await bench(async ({ toolset, page }) => {
      const home = digestOf(await toolset.execute('navigate', { url: `${workshop.url}/` }));
      const unknown = failure(await toolset.execute('click', { ref: 'e999' }));
      expect(unknown).toEqual({ kind: 'stale-ref', ref: 'e999', reason: 'unknown' });

      await page.evaluate(
        "document.querySelector('a[href=\"/members\"]').setAttribute('aria-label', 'Members lounge')",
      );
      const members = find(home, 'Members', 'link');
      const changed = await toolset.execute('click', { ref: members.ref });
      expect(failure(changed)).toEqual({ kind: 'stale-ref', ref: members.ref, reason: 'changed' });
      expect(changed.kind === 'error' && changed.text).toContain('read');

      digestOf(await toolset.execute('navigate', { url: `${workshop.url}/members` }));
      const email = find(home, 'Email address');
      expect(failure(await toolset.execute('type', { ref: email.ref, text: 'x' }))).toEqual({
        kind: 'stale-ref',
        ref: email.ref,
        reason: 'missing',
      });

      const fresh = digestOf(await toolset.execute('read', {}));
      const back = digestOf(await toolset.execute('click', { ref: find(fresh, 'Back to the workshop').ref }));
      expect(back.title).toBe('Workshop');
    });
  });

  it('says why an element cannot be acted on', async () => {
    await bench(async ({ toolset }) => {
      const home = digestOf(await toolset.execute('navigate', { url: `${workshop.url}/` }));

      const locked = failure(await toolset.execute('click', { ref: find(home, 'Locked').ref }));
      expect(locked).toMatchObject({ kind: 'not-interactable', ref: find(home, 'Locked').ref });
      expect(locked.kind === 'not-interactable' && locked.reason).toContain('disabled');

      const notAField = failure(
        await toolset.execute('type', { ref: find(home, 'Send it').ref, text: 'hello' }),
      );
      expect(notAField).toMatchObject({ kind: 'not-interactable' });
      expect(notAField.kind === 'not-interactable' && notAField.reason).toContain('button');

      const notASelect = failure(
        await toolset.execute('select', { ref: find(home, 'Email address').ref, option: 'x' }),
      );
      expect(notASelect).toMatchObject({ kind: 'not-interactable' });

      const noOption = failure(
        await toolset.execute('select', { ref: find(home, 'Plan').ref, option: 'weekly' }),
      );
      expect(noOption).toEqual({
        kind: 'no-such-option',
        ref: find(home, 'Plan').ref,
        option: 'weekly',
        options: ['Monthly', 'Annual'],
      });
    });
  });

  it('reports a navigation the wire refused, a click that timed out, and a page that is gone', async () => {
    const port = await closedPort();
    await bench(async ({ toolset, page }) => {
      const refused = failure(
        await toolset.execute('navigate', { url: `http://127.0.0.1:${String(port)}/` }),
      );
      expect(refused).toMatchObject({
        kind: 'navigation-failed',
        url: `http://127.0.0.1:${String(port)}/`,
      });
      expect(refused.kind === 'navigation-failed' && refused.reason).toMatch(/net::ERR_/);

      const covered = digestOf(await toolset.execute('navigate', { url: `${workshop.url}/covered` }));
      const timedOut = failure(
        await toolset.execute('click', { ref: find(covered, 'Under the overlay').ref }),
      );
      expect(timedOut).toMatchObject({ kind: 'timeout', tool: 'click' });
      // Playwright's own sentence, without its full stop, so the model's text reads as one sentence.
      expect(timedOut.kind === 'timeout' && timedOut.reason).toBe('Timeout 1500ms exceeded');

      await page.close();
      expect(failure(await toolset.execute('read', {})).kind).toBe('page-error');
    });
  });
});

describe('under the guard', () => {
  it('returns a refused navigate as a violation and refuses every browser tool after it', async () => {
    const executions: ToolExecution[] = [];
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const trail: StepEventPayload[] = [];

    const run = await guardedSession(
      { provider, policy: { allowlist: ['127.0.0.1'] } },
      async (page, _session, guard) => {
        const toolset = createBrowserToolset({
          page,
          guard,
          log: (payload) => {
            trail.push(payload);
            return Promise.resolve();
          },
        });
        executions.push(await toolset.execute('navigate', { url: `${workshop.url}/` }));
        executions.push(await toolset.execute('navigate', { url: `${away(workshop.url)}/partner` }));
        executions.push(await toolset.execute('read', {}));
        executions.push(await toolset.execute('declare_outcome', { status: 'failed', detail: 'blocked' }));
        finish();
        return 'finished';
      },
    );
    await finished;

    expect(run.outcome.kind).toBe('stopped');
    const [inside, outside, afterwards, declared] = executions;
    expect(inside?.kind).toBe('ok');
    expect(outside).toMatchObject({
      kind: 'error',
      failure: {
        kind: 'guardrail',
        stop: { kind: 'allowlist', attemptedUrl: `${away(workshop.url)}/partner`, via: 'navigation' },
      },
    });
    expect(outside?.kind === 'error' && outside.text).toContain('allowlist');
    expect(afterwards).toMatchObject({ kind: 'error', failure: { kind: 'guardrail' } });
    expect(declared).toMatchObject({ kind: 'outcome', status: 'failed' });
    expect(trail.map((entry) => [entry.name, entry.outcome])).toEqual([
      ['tool:navigate', 'ok'],
      ['tool:navigate', 'guardrail'],
      ['tool:read', 'guardrail'],
      ['tool:declare_outcome', 'declared'],
    ]);
  });
});
