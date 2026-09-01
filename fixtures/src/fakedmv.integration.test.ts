import { afterEach, describe, expect, it } from 'vitest';

import { type BookingRefusal, startFakedmvFixture } from './fakedmv.js';
import { assertNoLeakedFixtures } from './harness.js';

afterEach(() => {
  assertNoLeakedFixtures();
});

interface BookResult {
  readonly status: number;
  readonly payload: Record<string, unknown>;
}

/**
 * Booking is a client action, not a control-plane one, so these proofs drive
 * the public endpoint directly and use the control plane only to seed and to
 * read the awarded state back.
 */
async function book(url: string, slotId: string, name: string): Promise<BookResult> {
  const response = await fetch(`${url}/book`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slotId, name }),
  });
  return { status: response.status, payload: (await response.json()) as Record<string, unknown> };
}

const SLOT = { id: 'tue-0900', startsAt: '2026-09-08T09:00:00Z', label: 'Tuesday 9:00 AM' };

describe('fakedmv as a contested resource', () => {
  it('publishes a slot, lists it, awards it, and reads the booking back', async () => {
    const dmv = await startFakedmvFixture();
    try {
      await dmv.control.publishSlot(SLOT);

      const listing = await (await fetch(`${dmv.url}/appointments`)).text();
      expect(listing).toContain(`data-testid="slot-${SLOT.id}"`);
      expect(listing).toContain('Tuesday 9:00 AM');

      const result = await book(dmv.url, SLOT.id, 'Aarav');

      expect(result.status).toBe(200);
      expect(result.payload).toMatchObject({ slotId: SLOT.id, name: 'Aarav' });
      expect(await dmv.control.bookings()).toEqual([
        expect.objectContaining({ slotId: SLOT.id, name: 'Aarav' }),
      ]);
    } finally {
      await dmv.stop();
    }
  });

  it('awards a contested slot exactly once under concurrency', async () => {
    const dmv = await startFakedmvFixture();
    try {
      await dmv.control.publishSlot(SLOT);

      const [first, second] = await Promise.all([
        book(dmv.url, SLOT.id, 'Aarav'),
        book(dmv.url, SLOT.id, 'Rival'),
      ]);

      const results = [first, second];
      const winners = results.filter((result) => result.status === 200);
      const losers = results.filter((result) => result.status !== 200);

      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]?.payload).toMatchObject({ code: 'gone' satisfies BookingRefusal });

      const bookings = await dmv.control.bookings();
      expect(bookings).toHaveLength(1);
      expect(bookings[0]?.name).toBe(winners[0]?.payload.name);
    } finally {
      await dmv.stop();
    }
  });

  it('holds exactly one booking row when many clients contend for one slot', async () => {
    const dmv = await startFakedmvFixture();
    try {
      await dmv.control.publishSlot(SLOT);

      const attempts = await Promise.all(
        Array.from({ length: 12 }, (_unused, index) => book(dmv.url, SLOT.id, `client-${index}`)),
      );

      expect(attempts.filter((attempt) => attempt.status === 200)).toHaveLength(1);
      expect(attempts.filter((attempt) => attempt.payload.code === 'gone')).toHaveLength(11);
      expect(await dmv.control.bookings()).toHaveLength(1);
    } finally {
      await dmv.stop();
    }
  });

  it('refuses a slot withdrawn between listing and booking as gone', async () => {
    const dmv = await startFakedmvFixture();
    try {
      await dmv.control.publishSlot(SLOT);
      const listing = await (await fetch(`${dmv.url}/appointments`)).text();
      expect(listing).toContain(`data-testid="slot-${SLOT.id}"`);

      await dmv.control.withdrawSlot(SLOT.id);

      const result = await book(dmv.url, SLOT.id, 'Aarav');

      expect(result.payload).toMatchObject({ code: 'gone' });
      expect(await dmv.control.bookings()).toHaveLength(0);
      expect(await (await fetch(`${dmv.url}/appointments`)).text()).not.toContain(
        `data-testid="slot-${SLOT.id}"`,
      );
    } finally {
      await dmv.stop();
    }
  });

  it('refuses an unpublished slot id as gone rather than as missing', async () => {
    const dmv = await startFakedmvFixture();
    try {
      const result = await book(dmv.url, 'never-existed', 'Aarav');

      expect(result.status).not.toBe(404);
      expect(result.payload).toMatchObject({ code: 'gone' });
    } finally {
      await dmv.stop();
    }
  });

  it('refuses an already-taken slot as gone', async () => {
    const dmv = await startFakedmvFixture();
    try {
      await dmv.control.publishSlot(SLOT);
      await book(dmv.url, SLOT.id, 'Aarav');

      const result = await book(dmv.url, SLOT.id, 'Rival');

      expect(result.payload).toMatchObject({ code: 'gone' });
      expect(await dmv.control.bookings()).toHaveLength(1);
    } finally {
      await dmv.stop();
    }
  });

  it('distinguishes a transient failure from gone, so a client can tell retry from re-arm', async () => {
    const dmv = await startFakedmvFixture();
    try {
      await dmv.control.publishSlot(SLOT);
      await dmv.control.setFailureMode('transient');

      const transient = await book(dmv.url, SLOT.id, 'Aarav');

      expect(transient.payload).toMatchObject({ code: 'transient' satisfies BookingRefusal });
      expect(transient.status).not.toBe(200);
      expect(await dmv.control.bookings()).toHaveLength(0);

      await dmv.control.setFailureMode('none');
      const recovered = await book(dmv.url, SLOT.id, 'Aarav');
      expect(recovered.status).toBe(200);

      const gone = await book(dmv.url, SLOT.id, 'Rival');
      expect(gone.payload.code).not.toBe(transient.payload.code);
      expect(gone.status).not.toBe(transient.status);
    } finally {
      await dmv.stop();
    }
  });

  it('keeps contention on two instances independent', async () => {
    const a = await startFakedmvFixture();
    const b = await startFakedmvFixture();
    try {
      await a.control.publishSlot(SLOT);
      await b.control.publishSlot(SLOT);

      await book(a.url, SLOT.id, 'Aarav');

      expect(await a.control.bookings()).toHaveLength(1);
      expect(await b.control.bookings()).toHaveLength(0);
      expect((await book(b.url, SLOT.id, 'Rival')).status).toBe(200);
    } finally {
      await a.stop();
      await b.stop();
    }
  });
});
