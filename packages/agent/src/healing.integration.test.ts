import { createRecordingNotifier, type ExtractorSpec } from '@chief-of-staff/core';
import { startFakestoreFixture, type FakestoreControl, type FixtureHandle } from '@chief-of-staff/fixtures';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PROPOSE_EXTRACTOR_TOOL, createExtractorCreator } from './extractor.js';
import { extractWatchValue } from './healing.js';
import { createMemoryWatchStore, sampleWatch } from './testing/memory-store.js';
import { createScriptedLlm, useTool } from './testing/scripted-llm.js';

/**
 * The s1b redesign bait, sprung. A watch whose stored extractor leans on the
 * shop's theme (a class name) is checked across the fixture's redesign, which
 * rotates every class and keeps the hooks. The real creator runs over a
 * scripted model, so what the loop shows the model and what it does with the
 * proposal are genuinely exercised; only the judgement is written down.
 *
 * The store port is in memory here. Its Postgres binding is proved on its own
 * (`packages/watch`), and the composed check runs the two together.
 */

let shop: FixtureHandle<FakestoreControl>;

const CLASS_SPEC: ExtractorSpec = {
  version: 1,
  strategy: 'css',
  selector: 'dd.pd-value',
  attribute: null,
  parse: 'price',
};

const HOOK_SELECTOR = '[data-testid="product-price"]';

beforeAll(async () => {
  shop = await startFakestoreFixture();
  await shop.control.setProduct('widget', { title: 'Widget', price: 19.99, stock: 'in_stock' });
});

afterAll(async () => {
  await shop.stop();
});

beforeEach(async () => {
  await shop.control.setMode('normal');
});

async function page(): Promise<string> {
  return (await fetch(`${shop.url}/product/widget`)).text();
}

describe('self-healing against the fixture shop', () => {
  it('springs the redesign bait, heals with one model call, and reads on without another', async () => {
    const llm = createScriptedLlm(
      useTool(PROPOSE_EXTRACTOR_TOOL, { selector: HOOK_SELECTOR, rationale: 'the test hook outlives the theme' }),
    );
    const watch = sampleWatch({ url: `${shop.url}/product/widget`, extractor: CLASS_SPEC });
    const store = createMemoryWatchStore([watch]);
    const notifier = createRecordingNotifier();
    const ports = { store, creator: createExtractorCreator({ client: llm.client }), notifier };

    expect(await extractWatchValue(ports, watch, await page())).toMatchObject({
      ok: true,
      route: 'replayed',
      value: { kind: 'price', amount: 19.99 },
    });

    await shop.control.setMode('redesign');

    expect(await extractWatchValue(ports, store.row(watch.id), await page())).toMatchObject({
      ok: true,
      route: 'healed',
      value: { kind: 'price', amount: 19.99 },
    });
    expect(store.row(watch.id)).toMatchObject({
      extractor: { ...CLASS_SPEC, selector: HOOK_SELECTOR },
      health: 'healthy',
      lastError: null,
    });
    // The model was shown the page as it is now, once.
    expect(llm.requests()).toHaveLength(1);
    expect(JSON.stringify(llm.requests()[0]?.messages)).toContain('ProductView');

    expect(await extractWatchValue(ports, store.row(watch.id), await page())).toMatchObject({
      ok: true,
      route: 'replayed',
    });
    expect(llm.requests()).toHaveLength(1);
    expect(notifier.calls).toEqual([]);
  });

  it('degrades after a failed heal: one event, no more spend, and recovery when the page reads again', async () => {
    // The model's proposal does not match the redesigned page either.
    const llm = createScriptedLlm(useTool(PROPOSE_EXTRACTOR_TOOL, { selector: '.ProductView__price' }));
    const watch = sampleWatch({ url: `${shop.url}/product/widget`, extractor: CLASS_SPEC });
    const store = createMemoryWatchStore([watch]);
    const notifier = createRecordingNotifier();
    const ports = { store, creator: createExtractorCreator({ client: llm.client }), notifier };
    await shop.control.setMode('redesign');

    const first = await extractWatchValue(ports, watch, await page());

    expect(first).toMatchObject({ ok: false, health: 'degraded' });
    expect(store.row(watch.id)).toMatchObject({ extractor: CLASS_SPEC, health: 'degraded' });
    expect(store.row(watch.id).lastError).toContain('.ProductView__price');
    expect(notifier.events).toMatchObject([
      { type: 'degraded', watchId: watch.id, userId: watch.userId, url: watch.url },
    ]);

    const second = await extractWatchValue(ports, store.row(watch.id), await page());

    expect(second).toMatchObject({ ok: false, health: 'degraded' });
    expect(llm.requests()).toHaveLength(1);
    expect(notifier.calls).toHaveLength(1);

    await shop.control.setMode('normal');

    expect(await extractWatchValue(ports, store.row(watch.id), await page())).toMatchObject({
      ok: true,
      route: 'replayed',
      value: { kind: 'price', amount: 19.99 },
    });
    expect(store.row(watch.id)).toMatchObject({ health: 'healthy', lastError: null });
    expect(llm.requests()).toHaveLength(1);
  });
});
