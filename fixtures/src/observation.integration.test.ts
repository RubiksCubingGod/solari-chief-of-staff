import { afterEach, describe, expect, it } from 'vitest';

import { startFakenewsFixture } from './fakenews.js';
import { startFakestoreFixture } from './fakestore.js';
import { assertNoLeakedFixtures } from './harness.js';
import { BLOCKED_SHELL_STATE, NOT_FOUND_STATE } from './pages.js';

afterEach(() => {
  assertNoLeakedFixtures();
});

async function body(url: string): Promise<{ status: number; html: string }> {
  const response = await fetch(url);
  return { status: response.status, html: await response.text() };
}

/**
 * Reads a rendered observable the way a tier-0 extractor would: by its stable
 * hook rather than by position, so a layout change does not silently rewrite
 * what these proofs are asserting about.
 */
function testId(html: string, id: string): string | undefined {
  const match = new RegExp(`data-testid="${id}"[^>]*>([^<]*)<`).exec(html);
  return match?.[1]?.trim();
}

describe('fakestore as an observation target', () => {
  it('renders exactly what the control plane last set, and reads it back', async () => {
    const store = await startFakestoreFixture();
    try {
      await store.control.setProduct('drill', {
        title: 'Cordless Drill',
        price: 19.99,
        stock: 'in_stock',
      });

      const { status, html } = await body(`${store.url}/product/drill`);

      expect(status).toBe(200);
      expect(testId(html, 'product-title')).toBe('Cordless Drill');
      expect(testId(html, 'product-price')).toBe('$19.99');
      expect(testId(html, 'product-stock')).toBe('In stock');
      expect(await store.control.product('drill')).toMatchObject({
        title: 'Cordless Drill',
        price: 19.99,
        stock: 'in_stock',
      });
    } finally {
      await store.stop();
    }
  });

  it('changes the rendered value when the control plane sets it again', async () => {
    const store = await startFakestoreFixture();
    try {
      await store.control.setProduct('drill', {
        title: 'Cordless Drill',
        price: 19.99,
        stock: 'in_stock',
      });
      await store.control.setProduct('drill', {
        title: 'Cordless Drill',
        price: 14.5,
        stock: 'in_stock',
      });

      const { html } = await body(`${store.url}/product/drill`);

      expect(testId(html, 'product-price')).toBe('$14.50');
      expect((await store.control.product('drill')).price).toBe(14.5);
    } finally {
      await store.stop();
    }
  });

  it.each([
    ['a non-numeric price', 'free'],
    ['a negative price', -1],
  ])('refuses %s and leaves the rendered page unchanged', async (_label, price) => {
    const store = await startFakestoreFixture();
    try {
      await store.control.setProduct('drill', {
        title: 'Cordless Drill',
        price: 19.99,
        stock: 'in_stock',
      });
      const before = await body(`${store.url}/product/drill`);

      await expect(
        store.control.setProduct('drill', {
          title: 'Cordless Drill',
          price: price as number,
          stock: 'in_stock',
        }),
      ).rejects.toThrow(/400/);

      const after = await body(`${store.url}/product/drill`);
      expect(after.html).toBe(before.html);
      expect((await store.control.product('drill')).price).toBe(19.99);
    } finally {
      await store.stop();
    }
  });

  it('renders an out-of-stock product without any price', async () => {
    const store = await startFakestoreFixture();
    try {
      await store.control.setProduct('drill', {
        title: 'Cordless Drill',
        price: 19.99,
        stock: 'out_of_stock',
      });

      const { html } = await body(`${store.url}/product/drill`);

      expect(testId(html, 'product-stock')).toBe('Out of stock');
      expect(testId(html, 'product-price')).toBeUndefined();
      expect(html).not.toContain('19.99');
    } finally {
      await store.stop();
    }
  });

  it('serves an unseeded product as gone, with a body distinct from the blocked shell', async () => {
    const store = await startFakestoreFixture();
    try {
      const { status, html } = await body(`${store.url}/product/nothing-here`);

      expect(status).toBe(404);
      expect(html).toContain(NOT_FOUND_STATE);
      expect(html).not.toContain(BLOCKED_SHELL_STATE);
      expect(testId(html, 'not-found')).toBeDefined();
      expect(testId(html, 'captcha-challenge')).toBeUndefined();
    } finally {
      await store.stop();
    }
  });
});

describe('fakenews as an observation target', () => {
  it('renders exactly what the control plane last set, and reads it back', async () => {
    const news = await startFakenewsFixture();
    try {
      await news.control.setArticle('budget', {
        headline: 'Council approves budget',
        body: 'The vote was unanimous.',
      });

      const { status, html } = await body(`${news.url}/article/budget`);

      expect(status).toBe(200);
      expect(testId(html, 'article-headline')).toBe('Council approves budget');
      expect(html).toContain('The vote was unanimous.');
      expect(await news.control.article('budget')).toMatchObject({
        headline: 'Council approves budget',
        body: 'The vote was unanimous.',
      });
    } finally {
      await news.stop();
    }
  });

  it('changes the rendered headline when the control plane sets it again', async () => {
    const news = await startFakenewsFixture();
    try {
      await news.control.setArticle('budget', { headline: 'First', body: 'one' });
      await news.control.setArticle('budget', { headline: 'Second', body: 'two' });

      const { html } = await body(`${news.url}/article/budget`);

      expect(testId(html, 'article-headline')).toBe('Second');
      expect(html).toContain('two');
      expect(html).not.toContain('First');
    } finally {
      await news.stop();
    }
  });

  it('refuses an empty headline and leaves the rendered page unchanged', async () => {
    const news = await startFakenewsFixture();
    try {
      await news.control.setArticle('budget', { headline: 'First', body: 'one' });
      const before = await body(`${news.url}/article/budget`);

      await expect(news.control.setArticle('budget', { headline: '', body: 'one' })).rejects.toThrow(
        /400/,
      );

      expect((await body(`${news.url}/article/budget`)).html).toBe(before.html);
    } finally {
      await news.stop();
    }
  });

  it('serves a removed article as gone, with a body distinct from the blocked shell', async () => {
    const news = await startFakenewsFixture();
    try {
      const { status, html } = await body(`${news.url}/article/retracted`);

      expect(status).toBe(404);
      expect(html).toContain(NOT_FOUND_STATE);
      expect(html).not.toContain(BLOCKED_SHELL_STATE);
    } finally {
      await news.stop();
    }
  });
});

describe('the observation surface both sites share', () => {
  it('gives every observable value an accessible name and a data-testid hook', async () => {
    const store = await startFakestoreFixture();
    const news = await startFakenewsFixture();
    try {
      await store.control.setProduct('drill', {
        title: 'Cordless Drill',
        price: 19.99,
        stock: 'in_stock',
      });
      await news.control.setArticle('budget', { headline: 'Headline', body: 'Body' });

      const product = (await body(`${store.url}/product/drill`)).html;
      const article = (await body(`${news.url}/article/budget`)).html;

      for (const hook of ['product-title', 'product-price', 'product-stock']) {
        expect(product).toContain(`data-testid="${hook}"`);
      }
      for (const name of ['Price', 'Availability']) {
        expect(product).toContain(`aria-label="${name}"`);
      }
      for (const hook of ['article-headline', 'article-body']) {
        expect(article).toContain(`data-testid="${hook}"`);
      }
      expect(article).toContain('aria-label="Article body"');
    } finally {
      await store.stop();
      await news.stop();
    }
  });

  it('keeps two instances of the same site independent', async () => {
    const a = await startFakestoreFixture();
    const b = await startFakestoreFixture();
    try {
      await a.control.setProduct('drill', { title: 'A', price: 1, stock: 'in_stock' });
      await b.control.setProduct('drill', { title: 'B', price: 2, stock: 'in_stock' });

      expect((await a.control.product('drill')).title).toBe('A');
      expect((await b.control.product('drill')).title).toBe('B');
    } finally {
      await a.stop();
      await b.stop();
    }
  });
});
