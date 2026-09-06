/**
 * The geometry behind the sparkline, kept apart from the component that draws
 * it so the shape of the line is something a unit test can read numbers off
 * rather than something only a screenshot can see.
 */

export interface SparklineBox {
  readonly width: number;
  readonly height: number;
}

/**
 * Small on purpose: a sparkline sits inside a table row and is read as a
 * gesture, not measured. The numbers themselves are printed next to it.
 */
export const SPARKLINE_BOX: SparklineBox = { width: 120, height: 24 };

/**
 * The `points` attribute of an SVG polyline through `series`, oldest on the
 * left.
 *
 * Two degenerate cases are worth naming because both are ordinary here rather
 * than exceptional. A series of one is a watch that has been checked once, and
 * there is no line to draw through a single reading - it is plotted as a point
 * on the midline, because putting it at the top or the bottom would claim a
 * trend that one reading cannot have. A series whose readings are all equal is
 * a watch whose value has not moved, which is the most common thing a watch
 * does; it draws flat along the midline rather than dividing by a zero range.
 */
export function sparklinePoints(
  series: readonly number[],
  box: SparklineBox = SPARKLINE_BOX,
): string {
  if (series.length === 0) return '';

  const lowest = Math.min(...series);
  const highest = Math.max(...series);
  const range = highest - lowest;
  const midline = box.height / 2;
  // A single reading has no left-to-right span either, so the step is only
  // meaningful from the second point on.
  const step = series.length === 1 ? 0 : box.width / (series.length - 1);

  return series
    .map((value, index) => {
      const x = index * step;
      // SVG's y axis grows downward and a chart's grows upward, so the higher
      // reading has to become the smaller coordinate.
      const y = range === 0 ? midline : box.height - ((value - lowest) / range) * box.height;
      return `${format(x)},${format(y)}`;
    })
    .join(' ');
}

/**
 * Two decimals, with a trailing `.00` and a `-0` both trimmed away. Coordinates
 * are divisions of a box by a count and are almost never round; the rounding is
 * what keeps the attribute readable and the assertions about it exact.
 */
function format(value: number): string {
  const rounded = Number(value.toFixed(2));
  return String(rounded === 0 ? 0 : rounded);
}
