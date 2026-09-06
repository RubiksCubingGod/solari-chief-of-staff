import { SPARKLINE_BOX, sparklinePoints } from './sparkline-path';

/**
 * A watch's recent readings as a line.
 *
 * The readings are also written out in the `<title>`, which is what makes this
 * an image with a name rather than an unlabelled decoration. That is the
 * accessible reading of a chart that is otherwise pure geometry, and it is the
 * same string the end-to-end proof asserts against the seed - the picture and
 * the promise about the picture are one thing, so a sparkline cannot drift from
 * its own description.
 */
export function Sparkline({ series }: { readonly series: readonly number[] }) {
  if (series.length === 0) return null;

  return (
    <svg
      role="img"
      width={SPARKLINE_BOX.width}
      height={SPARKLINE_BOX.height}
      viewBox={`0 0 ${String(SPARKLINE_BOX.width)} ${String(SPARKLINE_BOX.height)}`}
      // Nothing is drawn outside the box, but a stroke is centred on its path,
      // so half a line width at the extremes would otherwise be clipped.
      overflow="visible"
    >
      <title>{`Readings, oldest first: ${series.join(', ')}`}</title>
      <polyline
        points={sparklinePoints(series)}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
