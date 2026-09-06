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

/**
 * The two stable layouts every observation target renders. `redesign` rotates
 * class names, element ids, and nesting; it never touches the semantic surface.
 */
export type Layout = 'normal' | 'redesign';

/** A rendered page, split so a hostile mode can wrap or withhold the body. */
export interface PageContent {
  readonly title: string;
  readonly main: string;
}

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

/**
 * The captcha shell.
 *
 * When `payload` is supplied (`blocked`), the real body travels base64-encoded
 * inside a script the client must run. The encoding is not decoration: served
 * as plain markup, a tier-0 extractor scraping for `data-testid` would find the
 * observable values in the shell and the mode would discriminate nothing. With
 * it, only a client that executes JavaScript can materialize the content, which
 * is exactly the claim `blocked` exists to make.
 *
 * When `payload` is omitted (`hard-blocked`), the shell carries no recoverable
 * body at all, so running scripts does not help - only the escalation marker does.
 */
export function blockedShellPage(payload?: string): string {
  const injection =
    payload === undefined
      ? []
      : [
          '      <script>',
          "        document.addEventListener('DOMContentLoaded', function () {",
          `          document.querySelector('main').innerHTML = atob('${Buffer.from(payload, 'utf8').toString('base64')}');`,
          // The marker travels with the body. Materializing the content and
          // leaving the head saying `blocked` would hand a script-executing
          // client two contradictory readings of one page, and the escalation
          // decision this marker exists to drive would either burn a tier-2
          // fetch on a page it already has or discard a good observation.
          `          document.querySelector('meta[name="fixture-state"]').setAttribute('content', '${NORMAL_STATE}');`,
          '        });',
          '      </script>',
        ];

  return documentShell({
    title: 'Checking your browser',
    state: BLOCKED_SHELL_STATE,
    main: [
      '      <div class="ch-challenge" data-testid="captcha-challenge">',
      '        <h1 class="ch-heading">Checking your browser</h1>',
      '        <p>Enable JavaScript and cookies to continue.</p>',
      '      </div>',
      ...injection,
    ].join('\n'),
  });
}
