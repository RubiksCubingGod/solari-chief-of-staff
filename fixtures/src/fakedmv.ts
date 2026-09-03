import { randomInt } from 'node:crypto';

import express, { type Express } from 'express';

import {
  buildInstanceControl,
  type ControlRequest,
  type FixtureHandle,
  type InstanceControl,
  mountInstanceRoutes,
  readRecord,
  startFixture,
  type StartFixtureOptions,
} from './harness.js';
import {
  buildModeControl,
  createModeState,
  type FixtureMode,
  type ModeControl,
  type ModeSeed,
} from './modes.js';
import { escapeHtml, type Layout, type PageContent } from './pages.js';

/**
 * The two ways a booking attempt can fail, kept deliberately distinct.
 * slot-sniping re-arms its watch on `gone` and retries on `transient`;
 * collapsing them into one code would make the engine either spin forever or
 * abandon a slot it could still win, so the fixture owes the distinction.
 */
export type BookingRefusal = 'gone' | 'transient';

export type FailureMode = 'none' | 'transient';

export interface SlotInput {
  readonly id: string;
  readonly startsAt: string;
  readonly label: string;
}

export interface Slot extends SlotInput {
  readonly status: 'open' | 'taken';
}

export interface Booking {
  readonly slotId: string;
  readonly name: string;
  readonly bookedAt: string;
  /** The confirmation the site hands back: `DMV-` and six digits. The one thing a booked task has to show for itself. */
  readonly reference: string;
}

/** Everything a fakedmv instance knows, as `GET /__test/state` reports it. */
export interface FakedmvState {
  readonly mode: FixtureMode;
  readonly escalationToken: string;
  readonly slots: readonly Slot[];
  readonly bookings: readonly Booking[];
  readonly failureMode: FailureMode;
}

export interface FakedmvSeed extends ModeSeed {
  readonly slots?: readonly SlotInput[];
  readonly failureMode?: FailureMode;
}

export interface FakedmvControl extends InstanceControl<FakedmvState, FakedmvSeed>, ModeControl {
  publishSlot(input: SlotInput): Promise<Slot>;
  withdrawSlot(id: string): Promise<void>;
  slots(): Promise<Slot[]>;
  bookings(): Promise<Booking[]>;
  setFailureMode(mode: FailureMode): Promise<void>;
}

interface MutableSlot extends SlotInput {
  status: 'open' | 'taken';
}

function parseSlot(body: unknown): SlotInput | string {
  const { id, startsAt, label } = readRecord(body);
  if (typeof id !== 'string' || id.trim() === '') {
    return 'id must be a non-empty string';
  }
  if (typeof startsAt !== 'string' || Number.isNaN(Date.parse(startsAt))) {
    return 'startsAt must be an ISO-8601 timestamp';
  }
  if (typeof label !== 'string' || label.trim() === '') {
    return 'label must be a non-empty string';
  }
  return { id, startsAt, label };
}

const INTRO =
  "Choose an open appointment below and enter the applicant's name to book it. " +
  'Appointments are released as they become available; check back if none is listed.';

/**
 * The calendar, the page a slot watch observes. The normal layout is a list;
 * the redesign is a table with every class, id and nesting changed, and the
 * semantic surface - heading, visible text, accessible names, `data-testid`
 * hooks - byte-identical, as `hostile-mode-surfaces` specifies.
 */
function calendarPage(slots: MutableSlot[], layout: Layout): PageContent {
  const open = slots.filter((slot) => slot.status === 'open');
  const title = 'Appointments';
  if (layout === 'redesign') {
    const rows =
      open.length === 0
        ? ['        <tr><td class="appt-none" data-testid="no-slots">No appointments available</td></tr>']
        : open.flatMap((slot) => [
            `        <tr class="appt" data-testid="slot-${escapeHtml(slot.id)}">`,
            `          <td><span class="appt-time" aria-label="Appointment time">${escapeHtml(slot.label)}</span></td>`,
            '          <td><form class="appt-book" method="post" action="/book">',
            `            <input type="hidden" name="slotId" value="${escapeHtml(slot.id)}" />`,
            '            <label class="appt-name">Name <input type="text" name="name" /></label>',
            `            <button type="submit" data-testid="book-${escapeHtml(slot.id)}">Book this appointment</button>`,
            '          </form></td>',
            '        </tr>',
          ]);
    return {
      title,
      main: [
        '      <div id="appt-shell">',
        `      <h1 class="appt-title">${title}</h1>`,
        `      <p class="appt-intro">${INTRO}</p>`,
        '      <table class="appt-grid"><tbody>',
        ...rows,
        '      </tbody></table>',
        '      </div>',
      ].join('\n'),
    };
  }
  const items =
    open.length === 0
      ? ['        <li class="dmv-empty" data-testid="no-slots">No appointments available</li>']
      : open.flatMap((slot) => [
          `        <li class="dmv-slot" data-testid="slot-${escapeHtml(slot.id)}">`,
          `          <span class="dmv-when" aria-label="Appointment time">${escapeHtml(slot.label)}</span>`,
          '          <form class="dmv-book" method="post" action="/book">',
          `            <input type="hidden" name="slotId" value="${escapeHtml(slot.id)}" />`,
          '            <label class="dmv-name">Name <input type="text" name="name" /></label>',
          `            <button type="submit" data-testid="book-${escapeHtml(slot.id)}">Book this appointment</button>`,
          '          </form>',
          '        </li>',
        ]);
  return {
    title,
    main: [
      `      <h1 class="dmv-title">${title}</h1>`,
      `      <p class="dmv-intro">${INTRO}</p>`,
      '      <ul class="dmv-slots">',
      ...items,
      '      </ul>',
    ].join('\n'),
  };
}

function mintReference(): string {
  return `DMV-${randomInt(0, 1_000_000).toString().padStart(6, '0')}`;
}

/**
 * Models the latency of persisting an award. It exists so the single-winner
 * proof is a real proof: with an await between the check and the write, an
 * implementation that claimed the slot after yielding would award it twice.
 */
function persistenceLatency(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

export function startFakedmvFixture(
  options: StartFixtureOptions = {},
): Promise<FixtureHandle<FakedmvControl>> {
  const slots = new Map<string, MutableSlot>();
  const bookings: Booking[] = [];
  let failureMode: FailureMode = 'none';
  // Slots are mutated in place when they are claimed, so the baseline holds
  // copies: otherwise winning a slot would rewrite the baseline that `reset`
  // exists to restore.
  let baselineSlots: MutableSlot[] = [];
  let baselineFailureMode: FailureMode = failureMode;
  // The calendar is a page an engine observes - the slot watch reads it
  // through the fetch ladder - so it carries the hostile modes. The booking
  // POST answers JSON in every mode, as fakegym's form POSTs do.
  const modes = createModeState();

  const isFailureMode = (value: unknown): value is FailureMode =>
    value === 'none' || value === 'transient';

  const mount = (app: Express): void => {
    app.use(express.urlencoded({ extended: false }));
    modes.mount(app);

    mountInstanceRoutes<FakedmvState>(app, {
      state: () => ({
        mode: modes.current(),
        escalationToken: modes.token(),
        slots: [...slots.values()],
        bookings: [...bookings],
        failureMode,
      }),
      seed: (body) => {
        const record = readRecord(body);
        const { slots: raw, failureMode: nextFailureMode } = record;
        if (nextFailureMode !== undefined && !isFailureMode(nextFailureMode)) {
          return 'failureMode must be none or transient';
        }
        let parsed: MutableSlot[] | undefined;
        if (raw !== undefined) {
          if (!Array.isArray(raw)) {
            return 'slots must be an array';
          }
          parsed = [];
          for (const entry of raw) {
            const slot = parseSlot(entry);
            if (typeof slot === 'string') {
              return slot;
            }
            parsed.push({ ...slot, status: 'open' });
          }
        }
        // Everything is checked before anything is applied, so a refused seed
        // leaves the instance exactly as it was.
        const refusal = modes.seed(record);
        if (refusal !== undefined) {
          return refusal;
        }
        if (parsed !== undefined) {
          slots.clear();
          for (const slot of parsed) {
            slots.set(slot.id, slot);
          }
        }
        if (isFailureMode(nextFailureMode)) {
          failureMode = nextFailureMode;
        }
        // A fresh starting state has no history: a booking left over from
        // before the seed would make `bookings` describe a calendar that no
        // longer exists.
        bookings.length = 0;
        baselineSlots = [...slots.values()].map((slot) => ({ ...slot }));
        baselineFailureMode = failureMode;
        return undefined;
      },
      reset: () => {
        slots.clear();
        for (const slot of baselineSlots) {
          slots.set(slot.id, { ...slot });
        }
        bookings.length = 0;
        failureMode = baselineFailureMode;
        modes.reset();
      },
    });

    app.get('/appointments', (request, response) => {
      modes.serve(request, response, (layout) => calendarPage([...slots.values()], layout));
    });

    app.post('/book', async (request, response) => {
      const { slotId, name } = readRecord(request.body);
      if (typeof slotId !== 'string' || typeof name !== 'string' || name.trim() === '') {
        response.status(400).json({ error: 'slotId and name must be non-empty strings' });
        return;
      }

      if (failureMode === 'transient') {
        response
          .status(503)
          .json({ code: 'transient' satisfies BookingRefusal, message: 'try again shortly' });
        return;
      }

      const slot = slots.get(slotId);
      if (slot === undefined || slot.status === 'taken') {
        response
          .status(409)
          .json({ code: 'gone' satisfies BookingRefusal, message: 'that appointment is gone' });
        return;
      }

      // Claim before yielding. Node runs this handler to its first await
      // without interleaving, so marking the slot taken here is what makes the
      // award single-winner under concurrency.
      slot.status = 'taken';
      await persistenceLatency();

      const booking: Booking = { slotId, name, bookedAt: new Date().toISOString(), reference: mintReference() };
      bookings.push(booking);
      response.json(booking);
    });

    app.post('/__test/slots', (request, response) => {
      const parsed = parseSlot(request.body);
      if (typeof parsed === 'string') {
        response.status(400).json({ error: parsed });
        return;
      }
      const slot: MutableSlot = { ...parsed, status: 'open' };
      slots.set(slot.id, slot);
      response.json(slot);
    });

    app.delete('/__test/slots/:id', (request, response) => {
      slots.delete(request.params.id);
      response.json({ ok: true });
    });

    app.get('/__test/slots', (_request, response) => {
      response.json([...slots.values()]);
    });

    app.get('/__test/bookings', (_request, response) => {
      response.json(bookings);
    });

    app.post('/__test/failure', (request, response) => {
      const { mode } = readRecord(request.body);
      if (mode !== 'none' && mode !== 'transient') {
        response.status(400).json({ error: 'mode must be none or transient' });
        return;
      }
      failureMode = mode;
      response.json({ mode });
    });
  };

  const buildControl = (request: ControlRequest): FakedmvControl => ({
    ...buildInstanceControl<FakedmvState, FakedmvSeed>(request),
    ...buildModeControl(request),
    publishSlot: (input) => request<Slot>('POST', '/__test/slots', input),
    withdrawSlot: async (id) => {
      await request('DELETE', `/__test/slots/${id}`);
    },
    slots: () => request<Slot[]>('GET', '/__test/slots'),
    bookings: () => request<Booking[]>('GET', '/__test/bookings'),
    setFailureMode: async (mode) => {
      await request('POST', '/__test/failure', { mode });
    },
  });

  return startFixture('fakedmv', mount, buildControl, options);
}
