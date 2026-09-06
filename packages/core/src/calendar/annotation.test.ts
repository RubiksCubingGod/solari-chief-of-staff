import { describe, expect, it } from 'vitest';

import {
  CALENDAR_ANNOTATIONS,
  annotationRank,
  canAnnotate,
  isCalendarAnnotation,
} from './annotation.js';

/**
 * The marks an engine leaves on a calendar entry, and which may overwrite
 * which. The rule is one line - a mark may replace one no stronger than itself
 * - and the tests are the cases that line has to get right.
 */

describe('CALENDAR_ANNOTATIONS', () => {
  it('runs from the mildest mark to the one that ends the story', () => {
    expect(CALENDAR_ANNOTATIONS).toEqual(['late', 'needs_attention', 'declined', 'handled']);
  });

  it('has a guard that knows its members and nothing else', () => {
    for (const annotation of CALENDAR_ANNOTATIONS) expect(isCalendarAnnotation(annotation)).toBe(true);
    expect(isCalendarAnnotation('cancelled')).toBe(false);
    expect(isCalendarAnnotation(null)).toBe(false);
  });
});

describe('annotationRank', () => {
  it('ranks no mark below every mark, and the marks in list order', () => {
    expect(annotationRank(null)).toBe(0);
    expect(CALENDAR_ANNOTATIONS.map(annotationRank)).toEqual([1, 2, 3, 4]);
  });
});

describe('canAnnotate', () => {
  it('writes any mark over an unmarked entry', () => {
    for (const annotation of CALENDAR_ANNOTATIONS) expect(canAnnotate(null, annotation)).toBe(true);
  });

  it('lets a stronger mark replace a weaker one', () => {
    expect(canAnnotate('late', 'needs_attention')).toBe(true);
    expect(canAnnotate('needs_attention', 'declined')).toBe(true);
    expect(canAnnotate('declined', 'handled')).toBe(true);
    expect(canAnnotate('late', 'handled')).toBe(true);
  });

  it('lets the same mark be written again', () => {
    expect(canAnnotate('late', 'late')).toBe(true);
    expect(canAnnotate('handled', 'handled')).toBe(true);
  });

  it('never lets a weaker mark erase a stronger one', () => {
    // A late reminder must not wipe out "do not auto-cancel this"; nothing
    // may wipe out "this has been cancelled".
    expect(canAnnotate('declined', 'late')).toBe(false);
    expect(canAnnotate('declined', 'needs_attention')).toBe(false);
    expect(canAnnotate('handled', 'late')).toBe(false);
    expect(canAnnotate('handled', 'declined')).toBe(false);
    expect(canAnnotate('needs_attention', 'late')).toBe(false);
  });
});
