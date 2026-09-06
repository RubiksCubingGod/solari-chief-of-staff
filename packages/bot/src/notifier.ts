import type { BookingEvent, NotifierPort, WatchEvent } from '@chief-of-staff/core';

import { NoBindingError, type SendToUser } from './outbound.js';

/**
 * The watch engine's notifier port, over the outbound door (slot-snipe-path:
 * "each outcome reaches the person through the s2 notifier port, which s7
 * implements over the bot's sendToUser").
 *
 * An event is one sentence in the chat the person bound, sent through the
 * same door as a reminder or a question and recorded the same way. The port
 * is at-least-once - a check tick retried after a failed write, a snipe
 * sweep after a rolled-back re-arm - so each send carries the event's dedup
 * key, and the door delivers a key once. Three things can go wrong, and each
 * is answered where it belongs: nobody to send to hands the event to the
 * fallback notifier (the process log), so an unbound person's event is still
 * on record; a delivery that settled failed is thrown, so the producer keeps
 * the event and tries again rather than the port claiming it arrived; and
 * any other failure of the door is a crash and stays one.
 */

export interface TelegramNotifierOptions {
  /** Where an event goes when the person has no chat bound. */
  readonly fallback: NotifierPort;
}

/** The sentence the person reads for an event. */
export function renderWatchEvent(event: WatchEvent): string {
  switch (event.type) {
    case 'triggered':
      return `Your watch fired: ${event.reason}. ${event.url}`;
    case 'blocked':
      return `Your watch on ${event.url} is blocked at every tier: ${event.reason}`;
    case 'degraded':
      return `Your watch on ${event.url} has degraded and needs your attention: ${event.reason}`;
    case 'booking':
      return renderBooking(event);
  }
}

function renderBooking(event: BookingEvent): string {
  switch (event.outcome) {
    case 'booked':
      return `Booked: ${event.slot.label}, reference ${event.reference ?? 'unknown'}. Your watch on ${event.url} stays paused.`;
    case 'rearmed':
      return `Not booked: ${event.reason}. Your watch on ${event.url} is looking again.`;
    case 'paused':
      return `Not booked: ${event.reason}. Your watch on ${event.url} is paused for your attention.`;
  }
}

export function createTelegramNotifier(sendToUser: SendToUser, options: TelegramNotifierOptions): NotifierPort {
  return {
    async notify(event) {
      let delivery;
      try {
        delivery = await sendToUser(event.userId, renderWatchEvent(event), { dedupKey: event.dedupKey });
      } catch (error: unknown) {
        if (error instanceof NoBindingError) {
          await options.fallback.notify(event);
          return;
        }
        throw error;
      }
      // `pending` is another emission of the same key still sending: the
      // event is on its way once, which is all this port promises.
      if (delivery.status === 'failed') {
        throw new Error(
          `the ${event.type} event was not delivered: ${delivery.error ?? 'the delivery failed without a reason'}`,
        );
      }
    },
  };
}
