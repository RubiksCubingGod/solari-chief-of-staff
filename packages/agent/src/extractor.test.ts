import type { ExtractorSpec, WatchPatch, WatchStore } from '@chief-of-staff/core';
import { describe, expect, it } from 'vitest';

import {
  EXTRACTOR_FAILURES,
  EXTRACTOR_MODEL,
  PROPOSE_EXTRACTOR_TOOL,
  createExtractorCreator,
  describeCreationFailure,
  provisionExtractor,
  type ExtractorCreation,
  type ExtractorSubject,
} from './extractor.js';
import { createScriptedLlm, outage, say, useTool } from './testing/scripted-llm.js';

/**
 * Extractor creation with the model's judgement scripted. The loop is one
 * forced tool call, so what is under test is everything around it: what the
 * model is shown, what its proposal has to survive before it is stored, and
 * what the watch is told when it does not.
 */

const PAGE = `<!doctype html><html><head><title>Widget</title>
<script>window.__tracking = { loaded: true };</script></head>
<body><main><article class="pd-card">
  <h1 class="pd-title" data-testid="product-title">Widget</h1>
  <dl class="pd-facts">
    <dt class="pd-term">Price</dt>
    <dd class="pd-value" data-testid="product-price" aria-label="Price">$19.99</dd>
    <dt class="pd-term">Availability</dt>
    <dd class="pd-value" data-testid="product-availability" aria-label="Availability">In stock</dd>
  </dl>
</article></main></body></html>`;

const URL = 'https://shop.test/product/widget';

const HOOK_SPEC: ExtractorSpec = {
  version: 1,
  strategy: 'css',
  selector: '[data-testid="product-price"]',
  attribute: null,
  parse: 'price',
};

function proposal(selector: string, extra: Record<string, unknown> = {}) {
  return useTool(PROPOSE_EXTRACTOR_TOOL, { selector, ...extra });
}

describe('createExtractorCreator', () => {
  it('names the ways creation can fail', () => {
    expect(EXTRACTOR_FAILURES).toEqual(['unavailable', 'no-proposal', 'invalid-spec', 'replay-failed']);
  });

  it('asks for one forced proposal over a cleaned snapshot, and validates it by replay before returning it', async () => {
    const llm = createScriptedLlm(proposal('[data-testid="product-price"]', { rationale: 'a test hook outlives a theme' }));
    const creator = createExtractorCreator({ client: llm.client });

    const creation = await creator.create({ url: URL, kind: 'price', html: PAGE });

    expect(creation).toEqual({
      ok: true,
      spec: HOOK_SPEC,
      value: { kind: 'price', amount: 19.99, currency: 'USD', raw: '$19.99' },
      rationale: 'a test hook outlives a theme',
    });

    const [request] = llm.requests();
    expect(request).toBeDefined();
    if (request === undefined) return;
    expect(request.body['model']).toBe(EXTRACTOR_MODEL);
    expect(request.toolNames).toEqual([PROPOSE_EXTRACTOR_TOOL]);
    expect(request.body['tool_choice']).toEqual({ type: 'tool', name: PROPOSE_EXTRACTOR_TOOL });
    expect(request.system).toEqual(expect.stringContaining('CSS selector'));
    const shown = JSON.stringify(request.messages);
    expect(shown).toContain(URL);
    expect(shown).toContain('data-testid=\\"product-price\\"');
    expect(shown).not.toContain('__tracking');
    expect(llm.requests()).toHaveLength(1);
  });

  it('reads an attribute proposal and a change watch\'s region hint', async () => {
    const llm = createScriptedLlm(proposal('dl.pd-facts', { attribute: null }));
    const creator = createExtractorCreator({ client: llm.client });

    const creation = await creator.create({ url: URL, kind: 'change', html: PAGE, hint: 'the facts list' });

    expect(creation).toMatchObject({
      ok: true,
      spec: { selector: 'dl.pd-facts', attribute: null, parse: 'digest' },
      value: { kind: 'digest', excerpt: 'Price $19.99 Availability In stock' },
      rationale: null,
    });
    expect(JSON.stringify(llm.requests()[0]?.messages)).toContain('the facts list');
  });

  it('honours the model override and passes an attribute through', async () => {
    const llm = createScriptedLlm(proposal('h1', { attribute: 'data-testid' }));
    const creator = createExtractorCreator({ client: llm.client, model: 'claude-sonnet-5', maxTokens: 300 });

    const creation = await creator.create({ url: URL, kind: 'change', html: PAGE });

    expect(creation).toMatchObject({ ok: true, spec: { attribute: 'data-testid' }, value: { excerpt: 'product-title' } });
    expect(llm.requests()[0]?.body['model']).toBe('claude-sonnet-5');
    expect(llm.requests()[0]?.body['max_tokens']).toBe(300);
  });

  it('reports an outage as unavailable, with the API\'s words', async () => {
    const llm = createScriptedLlm(outage(529));

    const creation = await createExtractorCreator({ client: llm.client }).create({ url: URL, kind: 'price', html: PAGE });

    expect(creation).toMatchObject({ ok: false, failure: 'unavailable' });
    if (!creation.ok) expect(creation.reason).toContain('529');
  });

  it('reports a model that answered in words as no proposal', async () => {
    const llm = createScriptedLlm(say('I cannot find a price on this page.'));

    const creation = await createExtractorCreator({ client: llm.client }).create({ url: URL, kind: 'price', html: PAGE });

    expect(creation).toEqual({
      ok: false,
      failure: 'no-proposal',
      reason: 'the model answered without proposing an extractor: I cannot find a price on this page.',
    });
  });

  it('refuses a proposal that is not a spec: a blank selector, or an attribute that is not a name', async () => {
    const blank = await createExtractorCreator({ client: createScriptedLlm(proposal('   ')).client }).create({
      url: URL,
      kind: 'price',
      html: PAGE,
    });
    expect(blank).toMatchObject({ ok: false, failure: 'invalid-spec' });
    if (!blank.ok) expect(blank.reason).toContain('"selector":"   "');

    const badAttribute = await createExtractorCreator({
      client: createScriptedLlm(proposal('dd', { attribute: 7 })).client,
    }).create({ url: URL, kind: 'price', html: PAGE });
    expect(badAttribute).toMatchObject({ ok: false, failure: 'invalid-spec' });
  });

  it('refuses a proposal that does not replay against the very page it was made from', async () => {
    const nothing = await createExtractorCreator({ client: createScriptedLlm(proposal('.price-tag')).client }).create({
      url: URL,
      kind: 'price',
      html: PAGE,
    });
    expect(nothing).toEqual({
      ok: false,
      failure: 'replay-failed',
      reason: '.price-tag did not replay against the page it was created from: no-match: nothing on the page matches .price-tag',
    });

    const noPrice = await createExtractorCreator({
      client: createScriptedLlm(proposal('[data-testid="product-availability"]')).client,
    }).create({ url: URL, kind: 'price', html: PAGE });
    expect(noPrice).toMatchObject({ ok: false, failure: 'replay-failed' });
    if (!noPrice.ok) expect(noPrice.reason).toContain('unparseable: no price in "In stock"');

    const broken = await createExtractorCreator({ client: createScriptedLlm(proposal('dd[')).client }).create({
      url: URL,
      kind: 'price',
      html: PAGE,
    });
    expect(broken).toMatchObject({ ok: false, failure: 'replay-failed' });
    if (!broken.ok) expect(broken.reason).toContain('invalid-selector');
  });
});

describe('describeCreationFailure', () => {
  it('puts the failure kind in front of the reason', () => {
    const creation: ExtractorCreation = { ok: false, failure: 'no-proposal', reason: 'nothing came back' };
    if (!creation.ok) expect(describeCreationFailure(creation)).toBe('no-proposal: nothing came back');
  });
});

interface RecordedPatch {
  readonly id: string;
  readonly patch: WatchPatch;
}

function recordingStore(): { store: Pick<WatchStore, 'updateWatch'>; patches: RecordedPatch[] } {
  const patches: RecordedPatch[] = [];
  return {
    patches,
    store: {
      updateWatch: (id, patch) => {
        patches.push({ id, patch });
        return Promise.resolve();
      },
    },
  };
}

function subject(kind: ExtractorSubject['kind'], condition: unknown = { drops_below: 15 }): ExtractorSubject {
  return { id: 'watch-1', url: URL, kind, condition };
}

describe('provisionExtractor', () => {
  it('stores a validated spec on the watch and clears its error', async () => {
    const llm = createScriptedLlm(proposal('[data-testid="product-price"]'));
    const { store, patches } = recordingStore();

    const creation = await provisionExtractor(createExtractorCreator({ client: llm.client }), store, subject('price'), PAGE);

    expect(creation).toMatchObject({ ok: true, spec: HOOK_SPEC });
    expect(patches).toEqual([{ id: 'watch-1', patch: { extractor: HOOK_SPEC, health: 'healthy', lastError: null } }]);
  });

  it('marks the watch needs_extractor with the reason when creation fails, and stores nothing', async () => {
    const llm = createScriptedLlm(proposal('.price-tag'));
    const { store, patches } = recordingStore();

    const creation = await provisionExtractor(createExtractorCreator({ client: llm.client }), store, subject('price'), PAGE);

    expect(creation).toMatchObject({ ok: false, failure: 'replay-failed' });
    expect(patches).toHaveLength(1);
    expect(patches[0]?.patch).toEqual({
      health: 'needs_extractor',
      lastError:
        'replay-failed: .price-tag did not replay against the page it was created from: no-match: nothing on the page matches .price-tag',
    });
    expect(patches[0]?.patch).not.toHaveProperty('extractor');
  });

  it('hands a change watch\'s region to the model as the hint', async () => {
    const llm = createScriptedLlm(proposal('dl.pd-facts'));
    const { store } = recordingStore();

    await provisionExtractor(
      createExtractorCreator({ client: llm.client }),
      store,
      subject('change', { region: 'the facts list under the title' }),
      PAGE,
    );

    expect(JSON.stringify(llm.requests()[0]?.messages)).toContain('the facts list under the title');
  });

  it('gives the model no hint when the change watch has no region, or the condition is unreadable', async () => {
    for (const condition of [{ region: null }, {}, 'garbage']) {
      const llm = createScriptedLlm(proposal('main'));
      const { store } = recordingStore();
      await provisionExtractor(createExtractorCreator({ client: llm.client }), store, subject('change', condition), PAGE);
      expect(JSON.stringify(llm.requests()[0]?.messages)).not.toContain('hint');
    }
  });
});
