/**
 * The link from a calendar entry to the site its cancellation runs on
 * (auto-cancel-path spec).
 *
 * An entry's `action` is free-form JSON, written by the person on the
 * dashboard or by the chat loop on their behalf. The one key the auto-cancel
 * arm reads is `site`: the registry key of the playbook that cancels there -
 * `fakegym` today - which is the same word a cancel task carries in its
 * input, so an entry and a task name a site the same way. Everything else in
 * `action` belongs to whoever wrote it.
 */
export function cancellationSiteOf(action: unknown): string | undefined {
  if (typeof action !== 'object' || action === null || Array.isArray(action)) return undefined;
  const site = (action as { readonly site?: unknown }).site;
  if (typeof site !== 'string') return undefined;
  const named = site.trim();
  return named === '' ? undefined : named;
}
