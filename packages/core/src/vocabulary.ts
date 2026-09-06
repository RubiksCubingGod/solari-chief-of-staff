/**
 * Builds a type guard over a closed string list. Used instead of hand-written
 * guards so adding a member to a list cannot leave a stale guard behind.
 *
 * Lives apart from the vocabulary itself so a module the index re-exports can
 * build its guards without importing the index that is importing it.
 */
export function memberGuard<T extends string>(
  values: readonly T[],
): (value: unknown) => value is T {
  const allowed: ReadonlySet<string> = new Set(values);
  return (value: unknown): value is T => typeof value === 'string' && allowed.has(value);
}
