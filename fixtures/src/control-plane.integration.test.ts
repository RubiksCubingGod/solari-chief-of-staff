import { afterEach, describe, expect, it } from 'vitest';

import { startFakedmvFixture } from './fakedmv.js';
import { startFakegymFixture } from './fakegym.js';
import { startFakenewsFixture } from './fakenews.js';
import { startFakestoreFixture } from './fakestore.js';
import { assertNoLeakedFixtures } from './harness.js';
import { FIXTURE_SITES } from './registry.js';

afterEach(() => {
  assertNoLeakedFixtures();
});

/**
 * `fixture-harness-contract` requires these of every fixture, in the same
 * shape. Named here rather than derived from the implementation, and asserted
 * against the routes each instance actually mounts, so a fixture that quietly
 * ships without one fails instead of redefining the requirement.
 */
const SHARED_ROUTES = ['GET /__test/state', 'POST /__test/seed', 'POST /__test/reset'];

const PRODUCT = { id: 'drill', title: 'Cordless Drill', price: 19.99, stock: 'in_stock' } as const;

describe('the control plane every fixture shares', () => {
  it('mounts state, seed and reset on all four fixtures', async () => {
    for (const site of FIXTURE_SITES) {
      const handle = await site.start();
      try {
        expect(handle.routes, `${site.name} control plane`).toEqual(
          expect.arrayContaining(SHARED_ROUTES),
        );
      } finally {
        await handle.stop();
      }
    }
  });

  it('mounts the mode route only where every mode has a specified meaning', async () => {
    // The contract cross-references `mode` to `hostile-mode-surfaces`, which
    // defines modes for pages an engine observes. Fakegym claims them too,
    // with a meaning of its own for `redesign`: the retention step hands the
    // flow to a partner host. A `redesign`ed booking POST has no specified
    // meaning, so fakedmv must not claim one.
    const withMode: string[] = [];
    for (const site of FIXTURE_SITES) {
      const handle = await site.start();
      try {
        if (handle.routes.includes('POST /__test/mode')) {
          withMode.push(site.name);
        }
      } finally {
        await handle.stop();
      }
    }
    expect(withMode.sort()).toEqual(['fakegym', 'fakenews', 'fakestore']);
  });
});

describe('seed, state and reset', () => {
  it('sets a whole fakestore in one call and restores that baseline after a mutation', async () => {
    const store = await startFakestoreFixture();
    try {
      await store.control.seed({
        products: [PRODUCT],
        mode: 'blocked',
        escalationToken: 'seeded-token',
      });

      expect(await store.control.state()).toEqual({
        mode: 'blocked',
        escalationToken: 'seeded-token',
        products: [PRODUCT],
      });

      await store.control.setProduct('drill', {
        title: 'Cordless Drill',
        price: 4.5,
        stock: 'out_of_stock',
      });
      await store.control.setMode('normal');
      expect((await store.control.state()).products[0]?.price).toBe(4.5);

      await store.control.reset();

      // Everything the seed established comes back, including the mode - and
      // without restarting the instance, which is the only thing that makes
      // reset worth having over another boot.
      expect(await store.control.state()).toEqual({
        mode: 'blocked',
        escalationToken: 'seeded-token',
        products: [PRODUCT],
      });
    } finally {
      await store.stop();
    }
  });

  it('applies nothing when a seed is refused', async () => {
    const store = await startFakestoreFixture();
    try {
      await store.control.seed({ products: [PRODUCT], escalationToken: 'seeded-token' });

      await expect(
        store.control.seed({
          // The second entry is bad; the first must not survive the refusal.
          products: [
            { id: 'ladder', title: 'Step Ladder', price: 30, stock: 'in_stock' },
            { id: 'saw', title: 'Saw', price: -1, stock: 'in_stock' },
          ],
          escalationToken: 'never-applied',
        }),
      ).rejects.toThrow(/400/);

      expect(await store.control.state()).toEqual({
        mode: 'normal',
        escalationToken: 'seeded-token',
        products: [PRODUCT],
      });
    } finally {
      await store.stop();
    }
  });

  it('sets a whole fakenews in one call and reads it back', async () => {
    const news = await startFakenewsFixture();
    try {
      const article = { id: 'quake', headline: 'Quake', body: 'It shook.' };
      await news.control.seed({ articles: [article] });

      expect(await news.control.state()).toEqual({
        mode: 'normal',
        escalationToken: 'fixture-escalation-token',
        articles: [article],
      });
    } finally {
      await news.stop();
    }
  });

  it('restores a fakegym to its seeded members and signs everybody out', async () => {
    const gym = await startFakegymFixture();
    try {
      await gym.control.seed({
        members: [{ id: 'm1', email: 'a@example.com', password: 'pw', name: 'Ada' }],
      });
      await gym.control.seedMember({
        id: 'm2',
        email: 'b@example.com',
        password: 'pw',
        name: 'Bee',
      });
      expect((await gym.control.state()).members).toHaveLength(2);

      await gym.control.reset();

      expect(await gym.control.state()).toEqual({
        members: [{ id: 'm1', email: 'a@example.com', name: 'Ada', status: 'active' }],
      });
    } finally {
      await gym.stop();
    }
  });

  it('never reports a fakegym confirmation code through the state route', async () => {
    const gym = await startFakegymFixture();
    try {
      await gym.control.seed({
        members: [{ id: 'm1', email: 'a@example.com', password: 'pw', name: 'Ada' }],
      });
      const code = await gym.control.confirmationCode('m1');
      const dumped = JSON.stringify(await gym.control.state());

      // `GET /__test/member/:id/code` stays the only way to learn it: a state
      // dump that leaked it would quietly dissolve the proof that an engine
      // asked the user rather than read the code itself.
      expect(dumped).not.toContain(code);
      expect(dumped).not.toContain('password');
    } finally {
      await gym.stop();
    }
  });

  it('restores a fakedmv slot that was won, and clears the booking with it', async () => {
    const dmv = await startFakedmvFixture();
    try {
      await dmv.control.seed({
        slots: [{ id: 's1', startsAt: '2026-09-02T09:00:00.000Z', label: 'Tuesday 09:00' }],
        failureMode: 'none',
      });

      const booked = await fetch(`${dmv.url}/book`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slotId: 's1', name: 'Ada' }),
      });
      expect(booked.status).toBe(200);

      const won = await dmv.control.state();
      expect(won.slots[0]?.status).toBe('taken');
      expect(won.bookings).toHaveLength(1);

      await dmv.control.reset();

      const after = await dmv.control.state();
      expect(after.slots[0]?.status).toBe('open');
      expect(after.bookings).toEqual([]);
      expect(after.failureMode).toBe('none');
    } finally {
      await dmv.stop();
    }
  });
});
