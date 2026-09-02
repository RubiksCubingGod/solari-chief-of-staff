import type { TaskKind } from './index.js';
import { parseApplicant, type SlotApplicant, type SlotCondition } from './watch/condition.js';
import type { WatchRecord } from './watch/store.js';
import { isSlotListing, type SlotListing } from './watch/value.js';

/**
 * The words a slot watch and the booking arm share.
 *
 * A slot watch that fires does not book: it queues a `book_slot` task and
 * pauses, and the task engine runs the booking playbook against this input.
 * Both sides read the same shape, and neither trusts the other's row: the
 * trigger writes it through `bookSlotInput`, the playbook reads it back
 * through `parseBookSlotInput` and refuses a task whose input is not one.
 */

export const BOOK_SLOT_TASK_KIND = 'book_slot' as const satisfies TaskKind;

export interface BookSlotInput {
  /** The registry key of the site to book on, as the watch condition named it. */
  readonly site: string;
  /** The watch that fired, so the outcome can re-arm or leave it paused. */
  readonly watchId: string;
  /** The page the slot was seen on. */
  readonly url: string;
  /** The slot the comparator picked: first matching slot wins. */
  readonly slot: SlotListing;
  readonly applicant: SlotApplicant;
  /** Whether the playbook may submit without asking the person first. */
  readonly auto_book: boolean;
}

/** The input a triggered slot watch hands the task it queues. */
export function bookSlotInput(
  watch: Pick<WatchRecord, 'id' | 'url'>,
  condition: SlotCondition,
  slot: SlotListing,
): BookSlotInput {
  return {
    site: condition.site,
    watchId: watch.id,
    url: watch.url,
    slot: { id: slot.id, label: slot.label },
    applicant: { name: condition.applicant.name },
    auto_book: condition.auto_book,
  };
}

/** The task input read back, or `undefined` when it is not one this vocabulary wrote. */
export function parseBookSlotInput(value: unknown): BookSlotInput | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const site = record['site'];
  const watchId = record['watchId'];
  const url = record['url'];
  const slot = record['slot'];
  const applicant = parseApplicant(record['applicant']);
  const autoBook = record['auto_book'];
  if (typeof site !== 'string' || site === '') return undefined;
  if (typeof watchId !== 'string' || watchId === '') return undefined;
  if (typeof url !== 'string' || url === '') return undefined;
  if (!isSlotListing(slot)) return undefined;
  if (applicant === undefined) return undefined;
  if (typeof autoBook !== 'boolean') return undefined;
  return { site, watchId, url, slot: { id: slot.id, label: slot.label }, applicant, auto_book: autoBook };
}

/**
 * Why a booking playbook would not book, as the watch's re-arm reads it off
 * the failed task. `slot-gone` re-arms the watch with its baseline cleared -
 * the slot may come back, and would be news; `not-confirmed` re-arms it with
 * the baseline kept - the person saw that slot and said no.
 */
export const BOOK_SLOT_REFUSALS = ['slot-gone', 'not-confirmed'] as const;
export type BookSlotRefusal = (typeof BOOK_SLOT_REFUSALS)[number];

export function isBookSlotRefusal(value: unknown): value is BookSlotRefusal {
  return typeof value === 'string' && (BOOK_SLOT_REFUSALS as readonly string[]).includes(value);
}

/**
 * The refusal a failed task's transition detail names - the runner's
 * `{ reason, detail: { code } }` - or `undefined` when the task failed for
 * some other reason, which is not a refusal at all.
 */
export function bookSlotRefusal(transitionDetail: unknown): BookSlotRefusal | undefined {
  const code = asRecord(asRecord(transitionDetail)?.['detail'])?.['code'];
  return isBookSlotRefusal(code) ? code : undefined;
}

/** What a booked task has to show for itself: the site's confirmation, on the task's result. */
export interface BookSlotBooked {
  readonly reference: string;
  readonly bookedAt: string;
}

/** The booking a succeeded task's result carries, or `undefined` when it carries none. */
export function parseBookSlotBooked(result: unknown): BookSlotBooked | undefined {
  const record = asRecord(result);
  const reference = record?.['reference'];
  const bookedAt = record?.['bookedAt'];
  if (typeof reference !== 'string' || reference === '') return undefined;
  if (typeof bookedAt !== 'string' || bookedAt === '') return undefined;
  return { reference, bookedAt };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
