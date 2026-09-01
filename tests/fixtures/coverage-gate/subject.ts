/**
 * The synthetic violation the coverage gate is proven against. `describe` has
 * two branches and the fixture test exercises exactly one, so a run of this
 * fixture under the `core/` thresholds must fail.
 */
export function describeSign(value: number): string {
  if (value >= 0) return 'not negative';
  return 'negative';
}
