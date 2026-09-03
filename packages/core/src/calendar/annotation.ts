import { memberGuard } from '../vocabulary.js';

/**
 * The marks an engine leaves on a calendar entry, weakest first.
 *
 * - `late`: its reminder went out after the day it was owed.
 * - `needs_attention`: something an engine owed it could not be done - a
 *   reminder with no chat to send it to, an auto-cancel with no linked site,
 *   no playbook, or nobody to ask - so a person has to look.
 * - `declined`: the person said no to cancelling it. Do not ask again for this
 *   renewal, and do not let a later reminder erase the no.
 * - `handled`: the cancellation went through. The entry's story is over.
 *
 * A mark may replace one no stronger than itself. That single rule is what
 * keeps a late reminder from wiping out "do not auto-cancel", and anything at
 * all from wiping out "this has been cancelled".
 */
export const CALENDAR_ANNOTATIONS = ['late', 'needs_attention', 'declined', 'handled'] as const;
export type CalendarAnnotation = (typeof CALENDAR_ANNOTATIONS)[number];

export const isCalendarAnnotation = memberGuard(CALENDAR_ANNOTATIONS);

/** No mark ranks 0; the marks rank in list order from 1. */
export function annotationRank(annotation: CalendarAnnotation | null): number {
  return annotation === null ? 0 : CALENDAR_ANNOTATIONS.indexOf(annotation) + 1;
}

/** Whether `next` may be written over `current`. */
export function canAnnotate(current: CalendarAnnotation | null, next: CalendarAnnotation): boolean {
  return annotationRank(next) >= annotationRank(current);
}
