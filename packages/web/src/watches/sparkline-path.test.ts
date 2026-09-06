import { describe, expect, it } from 'vitest';

import { SPARKLINE_BOX, sparklinePoints } from './sparkline-path';

describe('sparklinePoints', () => {
  it('plots the oldest reading on the left and the newest on the right', () => {
    // A falling price falls: the first reading is the highest, so it is drawn
    // at the top, which in SVG is the smallest y.
    expect(sparklinePoints([149, 139, 129])).toBe('0,0 60,12 120,24');
  });

  it('spans the full width whatever the length of the series', () => {
    expect(sparklinePoints([0, 10])).toBe('0,24 120,0');
    expect(sparklinePoints([0, 5, 10, 15, 20])).toBe('0,24 30,18 60,12 90,6 120,0');
  });

  it('draws nothing for a watch with no readings', () => {
    expect(sparklinePoints([])).toBe('');
  });

  it('puts a single reading on the midline rather than claiming a trend', () => {
    // One reading is neither high nor low - there is nothing to be high or low
    // against - so the only honest place for it is the middle.
    expect(sparklinePoints([5])).toBe(`0,${String(SPARKLINE_BOX.height / 2)}`);
  });

  it('draws a value that has not moved as a flat line, not a division by zero', () => {
    expect(sparklinePoints([3, 3, 3])).toBe('0,12 60,12 120,12');
  });

  it('scales to whatever box it is given', () => {
    expect(sparklinePoints([0, 1, 2], { width: 10, height: 3 })).toBe('0,3 5,1.5 10,0');
  });

  it('rounds coordinates to two places so the attribute stays readable', () => {
    // Three points across 120 gives thirds of 40, which is exact; seven gives
    // twentieths that are not.
    expect(sparklinePoints([1, 2, 3, 4, 5, 6, 7])).toBe(
      '0,24 20,20 40,16 60,12 80,8 100,4 120,0',
    );
    expect(sparklinePoints([0, 1, 0], { width: 7, height: 1 })).toBe('0,1 3.5,0 7,1');
  });

  it('handles readings below zero, which a change in a value can be', () => {
    expect(sparklinePoints([-10, 0, 10])).toBe('0,24 60,12 120,0');
  });
});
