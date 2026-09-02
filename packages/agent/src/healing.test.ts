import { createRecordingNotifier, type ExtractorSpec, type WatchValue } from '@chief-of-staff/core';
import { describe, expect, it } from 'vitest';

import type { ExtractorCreation, ExtractorCreator, ExtractorRequest } from './extractor.js';
import { EXTRACTION_ROUTES, degradedDedupKey, extractWatchValue, type ExtractionPorts } from './healing.js';
import { createMemoryWatchStore, sampleWatch, type MemoryWatchStore } from './testing/memory-store.js';

/**
 * The extract step of a check, with the model's judgement scripted at the
 * creator port. What is under test is the budget: when the model is asked,
 * when it is not, and what the watch says about itself either way.
 */

const NORMAL = `<!doctype html><html><body><main><article class="pd-card">
  <h1 class="pd-title" data-testid="product-title">Widget</h1>
  <dl class="pd-facts">
    <dt class="pd-term">Price</dt>
    <dd class="pd-value" data-testid="product-price" aria-label="Price">$19.99</dd>
    <dt class="pd-term">Availability</dt>
    <dd class="pd-value" data-testid="product-stock" aria-label="Availability">In stock</dd>
  </dl>
</article></main></body></html>`;

/** The same facts under rotated class names, as the fixture's redesign renders them. */
const REDESIGN = `<!doctype html><html><body><main><section class="ProductView" id="pv-root">
  <div class="ProductView__header"><h1 class="ProductView__name" data-testid="product-title">Widget</h1></div>
  <dl class="ProductView__facts">
    <dt class="ProductView__key">Price</dt>
    <dd class="ProductView__val" data-testid="product-price" aria-label="Price">$17.50</dd>
    <dt class="ProductView__key">Availability</dt>
    <dd class="ProductView__val" data-testid="product-stock" aria-label="Availability">In stock</dd>
  </dl>
</section></main></body></html>`;

const CLASS_SPEC: ExtractorSpec = {
  version: 1,
  strategy: 'css',
  selector: 'dd.pd-value',
  attribute: null,
  parse: 'price',
};

const HOOK_SPEC: ExtractorSpec = { ...CLASS_SPEC, selector: '[data-testid="product-price"]' };

const NORMAL_PRICE: WatchValue = { kind: 'price', amount: 19.99, currency: 'USD', raw: '$19.99' };
const REDESIGN_PRICE: WatchValue = { kind: 'price', amount: 17.5, currency: 'USD', raw: '$17.50' };

const NOW = new Date('2026-09-02T12:00:00.000Z');

const REFUSAL: ExtractorCreation = {
  ok: false,
  failure: 'no-proposal',
  reason: 'the model described the page instead of choosing a selector',
};

function accept(spec: ExtractorSpec, value: WatchValue): ExtractorCreation {
  return { ok: true, spec, value, rationale: null };
}

/** A creator with its answers written down; asking it more often than that is the failure under test. */
function scriptedCreator(...answers: readonly ExtractorCreation[]): {
  readonly creator: ExtractorCreator;
  readonly requests: ExtractorRequest[];
} {
  const remaining = [...answers];
  const requests: ExtractorRequest[] = [];
  return {
    requests,
    creator: {
      create(request) {
        requests.push(request);
        const answer = remaining.shift();
        return answer === undefined
          ? Promise.reject(new Error('the model was asked again after its budget was spent'))
          : Promise.resolve(answer);
      },
    },
  };
}

interface Bench {
  readonly ports: ExtractionPorts;
  readonly store: MemoryWatchStore;
  readonly notifier: ReturnType<typeof createRecordingNotifier>;
  readonly requests: ExtractorRequest[];
}

function bench(watch = sampleWatch(), ...answers: readonly ExtractorCreation[]): Bench {
  const store = createMemoryWatchStore([watch]);
  const notifier = createRecordingNotifier();
  const { creator, requests } = scriptedCreator(...answers);
  return { ports: { store, creator, notifier, now: () => NOW }, store, notifier, requests };
}

describe('extractWatchValue', () => {
  it('names the ways a value can arrive', () => {
    expect(EXTRACTION_ROUTES).toEqual(['replayed', 'created', 'healed']);
  });

  it('replays a stored extractor with no model call and writes nothing', async () => {
    const watch = sampleWatch({ extractor: CLASS_SPEC });
    const { ports, store, requests } = bench(watch);

    const extraction = await extractWatchValue(ports, watch, NORMAL);

    expect(extraction).toEqual({ ok: true, route: 'replayed', value: NORMAL_PRICE });
    expect(requests).toEqual([]);
    expect(store.patches).toEqual([]);
  });

  it.each(['degraded', 'blocked', 'needs_extractor'] as const)(
    'a value in hand makes a %s watch healthy again',
    async (health) => {
      const watch = sampleWatch({ extractor: CLASS_SPEC, health, lastError: 'something earlier' });
      const { ports, store } = bench(watch);

      const extraction = await extractWatchValue(ports, watch, NORMAL);

      expect(extraction).toMatchObject({ ok: true, route: 'replayed' });
      expect(store.patches).toEqual([{ id: watch.id, patch: { health: 'healthy', lastError: null } }]);
    },
  );

  it('writes an extractor on the first check and reads with it', async () => {
    const watch = sampleWatch();
    const { ports, store, requests } = bench(watch, accept(HOOK_SPEC, NORMAL_PRICE));

    const extraction = await extractWatchValue(ports, watch, NORMAL);

    expect(extraction).toEqual({ ok: true, route: 'created', value: NORMAL_PRICE });
    expect(requests).toEqual([{ url: watch.url, kind: 'price', html: NORMAL, hint: null }]);
    expect(store.row(watch.id)).toMatchObject({ extractor: HOOK_SPEC, health: 'healthy', lastError: null });
  });

  it("passes a change watch's region to the model as the hint", async () => {
    const watch = sampleWatch({ kind: 'change', condition: { region: 'the facts list' } });
    const digest: WatchValue = { kind: 'digest', digest: 'a'.repeat(64), excerpt: 'Price $19.99' };
    const { ports, requests } = bench(watch, accept({ ...HOOK_SPEC, selector: 'dl', parse: 'digest' }, digest));

    await extractWatchValue(ports, watch, NORMAL);

    expect(requests[0]?.hint).toBe('the facts list');
  });

  it('leaves a watch that could not get an extractor waiting, and does not ask again for it', async () => {
    const watch = sampleWatch();
    const { ports, store, requests } = bench(watch, REFUSAL);

    const first = await extractWatchValue(ports, watch, NORMAL);

    expect(first).toEqual({
      ok: false,
      health: 'needs_extractor',
      reason: 'no-proposal: the model described the page instead of choosing a selector',
    });
    expect(store.row(watch.id)).toMatchObject({ extractor: {}, health: 'needs_extractor', lastError: first.ok ? '' : first.reason });

    const second = await extractWatchValue(ports, store.row(watch.id), NORMAL);

    expect(second).toEqual({
      ok: false,
      health: 'needs_extractor',
      reason:
        'no extractor: no-proposal: the model described the page instead of choosing a selector; reset the watch to try again',
    });
    expect(requests).toHaveLength(1);
  });

  it('says so when a waiting watch has no record of why', async () => {
    const watch = sampleWatch({ health: 'needs_extractor', lastError: null });
    const { ports, requests } = bench(watch);

    const extraction = await extractWatchValue(ports, watch, NORMAL);

    expect(extraction).toEqual({
      ok: false,
      health: 'needs_extractor',
      reason: 'no extractor: the last attempt to write one failed; reset the watch to try again',
    });
    expect(requests).toEqual([]);
  });

  it('hands a parked reason back as it is once the row already carries it, instead of wrapping it again', async () => {
    const parked =
      'no extractor: no-proposal: the model described the page instead of choosing a selector; reset the watch to try again';
    const watch = sampleWatch({ health: 'needs_extractor', lastError: parked });
    const { ports, requests } = bench(watch);

    const extraction = await extractWatchValue(ports, watch, NORMAL);

    expect(extraction).toEqual({ ok: false, health: 'needs_extractor', reason: parked });
    expect(requests).toEqual([]);
  });

  it('heals once when the stored extractor breaks: one model call, the new spec stored, the value read', async () => {
    const watch = sampleWatch({ extractor: CLASS_SPEC, lastError: null });
    const { ports, store, requests, notifier } = bench(watch, accept(HOOK_SPEC, REDESIGN_PRICE));

    const healed = await extractWatchValue(ports, watch, REDESIGN);

    expect(healed).toEqual({ ok: true, route: 'healed', value: REDESIGN_PRICE });
    expect(requests).toEqual([{ url: watch.url, kind: 'price', html: REDESIGN, hint: null }]);
    expect(store.row(watch.id)).toMatchObject({ extractor: HOOK_SPEC, health: 'healthy', lastError: null });
    expect(notifier.calls).toEqual([]);

    // The next check reads with the new extractor and asks nobody.
    const next = await extractWatchValue(ports, store.row(watch.id), REDESIGN);

    expect(next).toEqual({ ok: true, route: 'replayed', value: REDESIGN_PRICE });
    expect(requests).toHaveLength(1);
  });

  it('degrades loudly when healing fails: degraded state, one event, no further model calls', async () => {
    const watch = sampleWatch({ extractor: CLASS_SPEC });
    const { ports, store, requests, notifier } = bench(watch, REFUSAL);

    const first = await extractWatchValue(ports, watch, REDESIGN);

    expect(first).toMatchObject({ ok: false, health: 'degraded' });
    if (first.ok) return;
    expect(first.reason).toContain('dd.pd-value');
    expect(first.reason).toContain(REFUSAL.reason);
    expect(store.row(watch.id)).toMatchObject({ extractor: CLASS_SPEC, health: 'degraded', lastError: first.reason });
    expect(notifier.events).toEqual([
      {
        type: 'degraded',
        watchId: watch.id,
        userId: watch.userId,
        url: watch.url,
        occurredAt: NOW.toISOString(),
        dedupKey: degradedDedupKey(watch.id, first.reason),
        reason: first.reason,
      },
    ]);

    const second = await extractWatchValue(ports, store.row(watch.id), REDESIGN);

    expect(second).toMatchObject({ ok: false, health: 'degraded' });
    if (second.ok) return;
    expect(second.reason).toContain('degraded');
    expect(second.reason).toContain('reset');
    expect(requests).toHaveLength(1);
    expect(notifier.calls).toHaveLength(1);
    // The row keeps the reason the incident began with, not the repeat.
    expect(store.row(watch.id).lastError).toBe(first.reason);
  });

  it('a degraded watch whose page reads again is healthy again, without a model call', async () => {
    const watch = sampleWatch({ extractor: CLASS_SPEC, health: 'degraded', lastError: 'the extractor broke' });
    const { ports, store, requests } = bench(watch);

    const extraction = await extractWatchValue(ports, watch, NORMAL);

    expect(extraction).toEqual({ ok: true, route: 'replayed', value: NORMAL_PRICE });
    expect(store.row(watch.id)).toMatchObject({ health: 'healthy', lastError: null });
    expect(requests).toEqual([]);
  });

  it('fails the check when the degraded event cannot be delivered, with the state already written', async () => {
    const watch = sampleWatch({ extractor: CLASS_SPEC });
    const { ports, store, notifier } = bench(watch, REFUSAL);
    notifier.failNextWith(new Error('the bot is down'));

    await expect(extractWatchValue(ports, watch, REDESIGN)).rejects.toThrow('the bot is down');

    expect(store.row(watch.id).health).toBe('degraded');
  });

  it('keeps time to itself when no clock is given', async () => {
    const watch = sampleWatch({ extractor: CLASS_SPEC });
    const store = createMemoryWatchStore([watch]);
    const notifier = createRecordingNotifier();
    const before = Date.now();

    await extractWatchValue({ store, creator: scriptedCreator(REFUSAL).creator, notifier }, watch, REDESIGN);

    const [event] = notifier.events;
    expect(event).toBeDefined();
    if (event === undefined) return;
    expect(Date.parse(event.occurredAt)).toBeGreaterThanOrEqual(before);
  });
});

describe('degradedDedupKey', () => {
  it('is the same for the same watch and reason, and differs otherwise', () => {
    const key = degradedDedupKey('watch-1', 'the extractor broke');
    expect(key).toMatch(/^[0-9a-f]{64}$/u);
    expect(degradedDedupKey('watch-1', 'the extractor broke')).toBe(key);
    expect(degradedDedupKey('watch-2', 'the extractor broke')).not.toBe(key);
    expect(degradedDedupKey('watch-1', 'something else broke')).not.toBe(key);
  });
});
