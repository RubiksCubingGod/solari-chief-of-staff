/**
 * The page vocabulary the observation targets share.
 *
 * The three state markers exist so a fetching client can tell *which* of the
 * fixture's states it is looking at without parsing prose. "Gone" and "blocked"
 * in particular must never be confused: one ends a watch and the other
 * escalates it, so they are separated by a machine-readable token rather than
 * by wording that a redesign could quietly change.
 */
export const NORMAL_STATE = 'fixture-state:normal';
export const NOT_FOUND_STATE = 'fixture-state:not-found';
export const BLOCKED_SHELL_STATE = 'fixture-state:blocked';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface DocumentOptions {
  readonly title: string;
  readonly state: string;
  readonly main: string;
}

export function documentShell({ title, state, main }: DocumentOptions): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="utf-8" />',
    `    <meta name="fixture-state" content="${state}" />`,
    `    <title>${escapeHtml(title)}</title>`,
    '  </head>',
    '  <body>',
    '    <main>',
    main,
    '    </main>',
    '  </body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * The "gone" page. Deliberately carries no captcha markup and no observable
 * value, so an extractor cannot mistake it for either a normal render or the
 * blocked shell.
 */
export function notFoundPage(what: string): string {
  return documentShell({
    title: 'Not found',
    state: NOT_FOUND_STATE,
    main: [
      '      <h1 data-testid="not-found">Not found</h1>',
      `      <p>No ${escapeHtml(what)} with that identifier exists.</p>`,
    ].join('\n'),
  });
}
