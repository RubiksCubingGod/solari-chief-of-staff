import { runInNewContext } from 'node:vm';

import { afterEach, describe, expect, it } from 'vitest';

import { startFakenewsFixture } from './fakenews.js';
import { startFakestoreFixture } from './fakestore.js';
import { assertNoLeakedFixtures } from './harness.js';
import { DEFAULT_ESCALATION_TOKEN, ESCALATION_HEADER } from './modes.js';
import { BLOCKED_SHELL_STATE, NORMAL_STATE } from './pages.js';

afterEach(() => {
  assertNoLeakedFixtures();
});

const PRODUCT = { title: 'Cordless Drill', price: 19.99, stock: 'in_stock' } as const;

async function get(url: string, headers: Record<string, string> = {}): Promise<string> {
  return (await fetch(url, { headers })).text();
}

/**
 * The surface a hostile mode is forbidden to change, extracted by the test
 * rather than by the fixture so the implementation cannot define the claim
 * into truth. These are exactly the axes the spec names: accessible names,
 * ARIA roles, heading structure, visible text, and `data-testid` hooks.
 */
function semanticSurface(html: string): Record<string, string[]> {
  const all = (pattern: RegExp): string[] =>
    [...html.matchAll(pattern)].map((match) => match.slice(1).join('=').trim());
  return {
    testIds: all(/data-testid="([^"]+)"[^>]*>([^<]*)</g),
    ariaLabels: all(/aria-label="([^"]+)"/g),
    roles: all(/role="([^"]+)"/g),
    headings: all(/<(h[1-6])[^>]*>([^<]*)</g),
    text: [html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()],
  };
}

/** The surface a redesign is required to change. */
function markupSurface(html: string): Record<string, string[]> {
  return {
    classes: [...html.matchAll(/class="([^"]+)"/g)].map((match) => match[1] ?? ''),
    ids: [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1] ?? ''),
  };
}

/**
 * Reads the state marker the way a consumer does - off the meta tag - rather
 * than by substring-matching the whole document. `blocked` deliberately carries
 * the normal marker inside the script it hands a JavaScript-executing client,
 * so a substring check would conflate what the server served with what a script
 * client ends up holding.
 */
function stateMarker(html: string): string | undefined {
  return /<meta name="fixture-state" content="([^"]+)"/.exec(html)?.[1];
}

/**
 * Runs the blocked shell's own injected script against a DOM the *test* owns.
 *
 * The script text is the real one the server emitted - only the document it
 * runs against is a stub, and that stub throws on any selector it was not told
 * about, so a change to what the shell queries fails here rather than silently
 * doing nothing. This proves what a JavaScript-executing client ends up
 * holding; a real browser rendering the same shell is owed by
 * `browser-substrate` and is recorded in HANDOFF.md.
 */
function materialize(html: string): { main: string; state: string } {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  expect(script, 'the blocked shell must carry a script').toBeDefined();

  const main = { innerHTML: '' };
  const meta = {
    content: BLOCKED_SHELL_STATE,
    setAttribute(name: string, value: string): void {
      if (name === 'content') {
        meta.content = value;
      }
    },
  };
  let ready: (() => void) | undefined;
  const document = {
    addEventListener(event: string, handler: () => void): void {
      if (event === 'DOMContentLoaded') {
        ready = handler;
      }
    },
    querySelector(selector: string): unknown {
      if (selector === 'main') {
        return main;
      }
      if (selector === 'meta[name="fixture-state"]') {
        return meta;
      }
      throw new Error(`the blocked shell queried an unmodelled selector: ${selector}`);
    },
  };

  runInNewContext(script ?? '', { document, atob });
  expect(ready, 'the shell must defer to DOMContentLoaded').toBeDefined();
  ready?.();

  return { main: main.innerHTML, state: meta.content };
}

describe('blocked mode', () => {
  it('serves a captcha shell to a plain HTTP fetch on the unchanged URL', async () => {
    const store = await startFakestoreFixture();
    try {
      await store.control.setProduct('drill', PRODUCT);
      const normal = await get(`${store.url}/product/drill`);
      expect(stateMarker(normal)).toBe(NORMAL_STATE);

      await store.control.setMode('blocked');
      const blocked = await get(`${store.url}/product/drill`);

      expect(stateMarker(blocked)).toBe(BLOCKED_SHELL_STATE);
      expect(blocked).toContain('data-testid="captcha-challenge"');
      expect(blocked).not.toContain('$19.99');
    } finally {
      await store.stop();
    }
  });

  it('withholds every observable value from the served markup', async () => {
    const store = await startFakestoreFixture();
    try {
      await store.control.setProduct('drill', PRODUCT);
      await store.control.setMode('blocked');

      const blocked = await get(`${store.url}/product/drill`);

      expect(blocked).not.toContain('data-testid="product-price"');
      expect(blocked).not.toContain('19.99');
      expect(blocked).not.toContain('Cordless Drill');
    } finally {
      await store.stop();
    }
  });

  it('carries the real content only as a payload a script client must decode', async () => {
    const store = await startFakestoreFixture();
    try {
      await store.control.setProduct('drill', PRODUCT);
      await store.control.setMode('blocked');

      const blocked = await get(`${store.url}/product/drill`);
      const payload = /atob\('([A-Za-z0-9+/=]+)'\)/.exec(blocked)?.[1];

      expect(payload).toBeDefined();
      const decoded = Buffer.from(payload ?? '', 'base64').toString('utf8');
      expect(decoded).toContain('data-testid="product-price"');
      expect(decoded).toContain('$19.99');
    } finally {
      await store.stop();
    }
  });

  it('hands a script-executing client one self-consistent document, not two readings', async () => {
    const store = await startFakestoreFixture();
    try {
      await store.control.setProduct('drill', PRODUCT);
      await store.control.setMode('blocked');

      const blocked = await get(`${store.url}/product/drill`);
      expect(stateMarker(blocked)).toBe(BLOCKED_SHELL_STATE);

      const materialized = materialize(blocked);

      // The body arrives...
      expect(materialized.main).toContain('data-testid="product-price"');
      expect(materialized.main).toContain('$19.99');
      expect(materialized.main).not.toContain('captcha-challenge');
      // ...and the page stops claiming to be blocked. A client that keys on the
      // documented marker to decide whether to escalate must not read `blocked`
      // off a page it has already successfully observed.
      expect(materialized.state).toBe(NORMAL_STATE);
    } finally {
      await store.stop();
    }
  });
});

describe('hard-blocked mode', () => {
  it('serves the shell to a request carrying no escalation marker', async () => {
    const store = await startFakestoreFixture();
    try {
      await store.control.setProduct('drill', PRODUCT);
      await store.control.setMode('hard-blocked');

      const shell = await get(`${store.url}/product/drill`);

      expect(stateMarker(shell)).toBe(BLOCKED_SHELL_STATE);
      expect(shell).not.toContain('19.99');
      expect(shell).not.toContain('atob(');
    } finally {
      await store.stop();
    }
  });

  it('serves the real content to a request carrying the seeded marker', async () => {
    const store = await startFakestoreFixture();
    try {
      await store.control.setProduct('drill', PRODUCT);
      await store.control.setMode('hard-blocked');

      const content = await get(`${store.url}/product/drill`, {
        [ESCALATION_HEADER]: DEFAULT_ESCALATION_TOKEN,
      });

      expect(stateMarker(content)).toBe(NORMAL_STATE);
      expect(content).toContain('$19.99');
    } finally {
      await store.stop();
    }
  });

  it('compares the marker rather than merely detecting it', async () => {
    const store = await startFakestoreFixture();
    try {
      await store.control.setProduct('drill', PRODUCT);
      await store.control.seed({ escalationToken: 'the-real-token' });
      await store.control.setMode('hard-blocked');

      for (const wrong of ['', 'not-the-token', 'the-real-token-with-suffix', 'THE-REAL-TOKEN']) {
        const shell = await get(`${store.url}/product/drill`, { [ESCALATION_HEADER]: wrong });
        expect(stateMarker(shell), `token ${JSON.stringify(wrong)} must not pass`).toBe(
          BLOCKED_SHELL_STATE,
        );
      }

      const content = await get(`${store.url}/product/drill`, {
        [ESCALATION_HEADER]: 'the-real-token',
      });
      expect(content).toContain('$19.99');
    } finally {
      await store.stop();
    }
  });
});

describe('redesign mode', () => {
  it('changes the markup surface and leaves the semantic surface byte-identical', async () => {
    const store = await startFakestoreFixture();
    try {
      await store.control.setProduct('drill', PRODUCT);
      const before = await get(`${store.url}/product/drill`);

      await store.control.setMode('redesign');
      const after = await get(`${store.url}/product/drill`);

      expect(semanticSurface(after)).toEqual(semanticSurface(before));
      expect(markupSurface(after).classes).not.toEqual(markupSurface(before).classes);
      expect(after).not.toBe(before);
    } finally {
      await store.stop();
    }
  });

  it('renders the same second layout every time, so a failure reproduces', async () => {
    const store = await startFakestoreFixture();
    try {
      await store.control.setProduct('drill', PRODUCT);
      await store.control.setMode('redesign');

      const first = await get(`${store.url}/product/drill`);
      const second = await get(`${store.url}/product/drill`);

      expect(second).toBe(first);
    } finally {
      await store.stop();
    }
  });

  it('holds the semantic surface for fakenews as well', async () => {
    const news = await startFakenewsFixture();
    try {
      await news.control.setArticle('budget', {
        headline: 'Council approves budget',
        body: 'The vote was unanimous.',
      });
      const before = await get(`${news.url}/article/budget`);

      await news.control.setMode('redesign');
      const after = await get(`${news.url}/article/budget`);

      expect(semanticSurface(after)).toEqual(semanticSurface(before));
      expect(markupSurface(after).classes).not.toEqual(markupSurface(before).classes);
    } finally {
      await news.stop();
    }
  });
});

describe('the mode control plane', () => {
  it('refuses an unknown mode and leaves the instance in its current mode', async () => {
    const store = await startFakestoreFixture();
    try {
      await store.control.setProduct('drill', PRODUCT);
      await store.control.setMode('blocked');

      await expect(store.control.setMode('sideways' as 'blocked')).rejects.toThrow(/400/);

      expect(await store.control.mode()).toBe('blocked');
      expect(stateMarker(await get(`${store.url}/product/drill`))).toBe(BLOCKED_SHELL_STATE);
    } finally {
      await store.stop();
    }
  });

  it('does not leak a mode between two instances of the same site', async () => {
    const a = await startFakestoreFixture();
    const b = await startFakestoreFixture();
    try {
      await a.control.setProduct('drill', PRODUCT);
      await b.control.setProduct('drill', PRODUCT);
      await a.control.setMode('blocked');

      expect(stateMarker(await get(`${a.url}/product/drill`))).toBe(BLOCKED_SHELL_STATE);
      expect(stateMarker(await get(`${b.url}/product/drill`))).toBe(NORMAL_STATE);
      expect(await b.control.mode()).toBe('normal');
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  it('applies ?mode= to one request only, without disturbing the stored mode', async () => {
    const store = await startFakestoreFixture();
    try {
      await store.control.setProduct('drill', PRODUCT);

      const shorthand = await get(`${store.url}/product/drill?mode=blocked`);
      expect(stateMarker(shorthand)).toBe(BLOCKED_SHELL_STATE);

      expect(await store.control.mode()).toBe('normal');
      expect(stateMarker(await get(`${store.url}/product/drill`))).toBe(NORMAL_STATE);
    } finally {
      await store.stop();
    }
  });

  it('keeps the mode in effect across requests until it is changed back', async () => {
    const store = await startFakestoreFixture();
    try {
      await store.control.setProduct('drill', PRODUCT);
      await store.control.setMode('blocked');

      expect(stateMarker(await get(`${store.url}/product/drill`))).toBe(BLOCKED_SHELL_STATE);
      expect(stateMarker(await get(`${store.url}/product/drill`))).toBe(BLOCKED_SHELL_STATE);

      await store.control.setMode('normal');
      expect(stateMarker(await get(`${store.url}/product/drill`))).toBe(NORMAL_STATE);
    } finally {
      await store.stop();
    }
  });
});
