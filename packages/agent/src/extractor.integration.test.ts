import Anthropic from '@anthropic-ai/sdk';
import { replayExtractor } from '@chief-of-staff/core';
import { startFakestoreFixture, type FakestoreControl, type FixtureHandle } from '@chief-of-staff/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createExtractorCreator } from './extractor.js';
import { liveLlmSkipReason } from './live-llm.js';

/**
 * The one extractor proof that talks to a real model.
 *
 * Every other proof of creation scripts the proposal, which pins what the loop
 * does with one but cannot fail when the proposal itself is the problem: a
 * tool description the model reads as "any selector", a preference for the
 * theme's class names over the page's stable hooks. So this asks a real Claude
 * for a selector on a real fixture page and checks that what it proposes both
 * replays to the right price and survives the shop's redesign - which is the
 * property the whole self-healing budget is sized around.
 *
 * It sits in the ordinary `integration` project so the gate still loads,
 * typechecks and lints it; the guard below is what keeps it from spending.
 */

const skipReason = liveLlmSkipReason(process.env);

const suiteName =
  skipReason === undefined
    ? 'live extractor creation @live-llm'
    : `live extractor creation @live-llm — ${skipReason}`;

const LIVE_TIMEOUT_MS = 120_000;

let shop: FixtureHandle<FakestoreControl>;

describe.skipIf(skipReason !== undefined)(suiteName, () => {
  beforeAll(async () => {
    shop = await startFakestoreFixture();
    await shop.control.setProduct('kettle', { title: 'Stovetop Kettle', price: 42.5, stock: 'in_stock' });
  });

  afterAll(async () => {
    await shop.stop();
  });

  it(
    'creates an extractor for the product page that replays to its price, in either layout',
    async () => {
      const url = `${shop.url}/product/kettle`;
      const html = await (await fetch(url)).text();
      const creator = createExtractorCreator({ client: new Anthropic() });

      const creation = await creator.create({ url, kind: 'price', html });

      expect(creation).toMatchObject({ ok: true, value: { kind: 'price', amount: 42.5 } });
      if (!creation.ok) return;

      // The redesign rotates every class and id and keeps the hooks; a
      // selector worth storing reads the same price from both.
      await shop.control.setMode('redesign');
      const redesigned = await (await fetch(url)).text();
      expect(replayExtractor(creation.spec, redesigned)).toMatchObject({ ok: true, value: { amount: 42.5 } });
    },
    LIVE_TIMEOUT_MS,
  );
});
