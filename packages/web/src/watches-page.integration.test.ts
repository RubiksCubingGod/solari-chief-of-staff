import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REQUEST_LINK_PATH } from './auth/session';
import { startWebDevServer, type WebDevServer } from './testing/dev-server';

/**
 * The watches page, proven against the seed rather than against a screenshot.
 *
 * Every assertion below names a value that was planted a few lines earlier, so
 * a failure says which fact the page got wrong. The sparkline is included in
 * that: it carries its readings in its own `<title>`, which is both how a
 * screen reader is told what the line means and how this test reads the line
 * without measuring pixels.
 *
 * A browser rather than `fetch`, because two of these properties do not exist
 * outside one. Pausing a watch is a form post that redirects and re-renders,
 * and the session that carries it is a cookie set by the API on one loopback
 * port and spent by the dashboard on another.
 */

/**
 * The fixture the API package builds. Restated here rather than imported as a
 * type because `packages/web/tsconfig.json` - deliberately - cannot resolve
 * anything outside the dashboard.
 */
interface SeededWatch {
  readonly id: string;
  readonly url: string;
  readonly status: 'active' | 'paused';
  readonly series: readonly number[];
}

interface SeededAccount {
  readonly userId: string;
  readonly email: string;
  readonly watches: readonly SeededWatch[];
}

interface AuthStack {
  readonly url: string;
  readonly email: string;
  lastLink(): string | undefined;
  clearMail(): void;
  seedAccount(options: {
    readonly email: string;
    readonly watches?: readonly {
      readonly url: string;
      readonly status?: 'active' | 'paused';
      readonly series?: readonly number[];
    }[];
  }): Promise<SeededAccount>;
  stop(): Promise<void>;
}

interface AuthStackModule {
  startAuthStack(options: { readonly dashboardBaseUrl: string }): Promise<AuthStack>;
  reserveLoopbackPort(): Promise<number>;
}

/**
 * Loaded through a variable rather than a literal: `eslint.config.js` keeps
 * this package away from the database and this package's TypeScript project
 * resolves like the bundler that builds it, so a written-out specifier would
 * fail the type check even though the runner resolves it perfectly. See
 * `auth-guard.integration.test.ts`, which does the same for the same reason.
 */
const AUTH_STACK_MODULE = '@chief-of-staff/api/testing';

const LAPTOP = 'https://example.test/laptop';
const GPU = 'https://example.test/gpu';
const PAUSEABLE = 'https://example.test/pauseable';
const SOMEBODY_ELSES = 'https://example.test/not-yours';

/** Readings chosen to be distinctive, so a wrong series cannot look right. */
const LAPTOP_SERIES = [149, 139, 129] as const;
const PAUSEABLE_SERIES = [7, 8] as const;

let stack: AuthStack;
let web: WebDevServer;
let browser: Browser;
let watcher: SeededAccount;
let stranger: SeededAccount;

beforeAll(async () => {
  const module = (await import(AUTH_STACK_MODULE)) as AuthStackModule;
  const port = await module.reserveLoopbackPort();
  const dashboardBaseUrl = `http://127.0.0.1:${String(port)}`;

  stack = await module.startAuthStack({ dashboardBaseUrl });
  web = await startWebDevServer({ apiBaseUrl: stack.url, port });
  browser = await chromium.launch();

  watcher = await stack.seedAccount({
    email: 'watcher@example.test',
    watches: [
      { url: LAPTOP, series: LAPTOP_SERIES },
      // Never checked: a watch can exist before it has any history, and the
      // page has to say so rather than draw an empty chart.
      { url: GPU },
      { url: PAUSEABLE, series: PAUSEABLE_SERIES },
    ],
  });
  stranger = await stack.seedAccount({
    email: 'stranger@example.test',
    watches: [{ url: SOMEBODY_ELSES, series: [42] }],
  });
}, 300_000);

afterAll(async () => {
  await browser.close();
  await web.stop();
  await stack.stop();
});

/** Signs a browser in the way a person does, then leaves it on `/watches`. */
async function openWatchesAs(page: Page, address: string): Promise<void> {
  stack.clearMail();
  await page.goto(`${web.url}${REQUEST_LINK_PATH}`);
  await page.getByLabel('Email address').fill(address);
  await page.getByRole('button', { name: /sign-in link/iu }).click();
  await page.waitForURL(/\/login\?sent=1$/u);

  const link = stack.lastLink();
  expect(link, `no sign-in link was mailed to ${address}`).toBeDefined();
  await page.goto(link ?? '');
  await page.goto(`${web.url}/watches`);
  // Anything other than the watches page here - a redirect back to sign-in,
  // most likely - would otherwise surface as a confusing "element not found".
  expect(new URL(page.url()).pathname).toBe('/watches');
}

/** The card for one watch, found by the address it is headed with. */
function cardFor(page: Page, url: string): Locator {
  return page.locator('article').filter({ has: page.getByRole('heading', { name: url }) });
}

async function withPage<T>(run: (page: Page) => Promise<T>): Promise<T> {
  // A context per test, so a session or a cookie left behind by one test is
  // never what makes the next one pass.
  const context = await browser.newContext();
  try {
    return await run(await context.newPage());
  } finally {
    await context.close();
  }
}

describe('the watches page', () => {
  it(
    'renders exactly the watches the signed-in account owns',
    async () =>
      withPage(async (page) => {
        await openWatchesAs(page, watcher.email);

        const headings = await page.getByRole('heading', { level: 2 }).allTextContents();
        expect([...headings].sort()).toEqual([...watcher.watches.map((w) => w.url)].sort());
      }),
    240_000,
  );

  it(
    'shows each watch with its last reading and a sparkline of its seeded series',
    async () =>
      withPage(async (page) => {
        await openWatchesAs(page, watcher.email);

        const laptop = cardFor(page, LAPTOP);
        const text = (await laptop.textContent()) ?? '';
        // The newest reading, which is the one the watch row itself carries -
        // asserted here so a page that read the oldest, or read the series
        // where it should have read the summary, cannot pass.
        expect(text).toContain(String(LAPTOP_SERIES.at(-1)));
        expect(text).not.toContain('never checked');

        // The line, read as the readings it claims to plot, in seeded order.
        expect(await laptop.locator('svg title').textContent()).toBe(
          `Readings, oldest first: ${LAPTOP_SERIES.join(', ')}`,
        );
      }),
    240_000,
  );

  it(
    'says a watch has never been checked instead of drawing an empty line',
    async () =>
      withPage(async (page) => {
        await openWatchesAs(page, watcher.email);

        const gpu = cardFor(page, GPU);
        expect(await gpu.textContent()).toContain('never checked');
        expect(await gpu.locator('svg').count()).toBe(0);
      }),
    240_000,
  );

  it(
    'never shows another account its neighbour rows',
    async () =>
      withPage(async (page) => {
        await openWatchesAs(page, stranger.email);

        const headings = await page.getByRole('heading', { level: 2 }).allTextContents();
        expect(headings).toEqual([SOMEBODY_ELSES]);
        // Checked against the whole document, not just the cards: a watch that
        // leaked into a hidden field or a form action would still be a leak.
        expect(await page.locator('body').textContent()).not.toContain(LAPTOP);
      }),
    240_000,
  );

  it(
    'pauses a watch from the page and shows it paused on the very next render',
    async () =>
      withPage(async (page) => {
        await openWatchesAs(page, watcher.email);

        const card = cardFor(page, PAUSEABLE);
        expect(await card.textContent()).toContain('active');

        await card.getByRole('button', { name: `Pause ${PAUSEABLE}` }).click();
        await page.waitForURL(/\/watches$/u);

        // Re-read from the API after the redirect, not assumed from the click.
        const paused = cardFor(page, PAUSEABLE);
        expect(await paused.textContent()).toContain('paused');
        await expectVisible(paused.getByRole('button', { name: `Resume ${PAUSEABLE}` }));

        // And back, so this test leaves the seed as it found it.
        await paused.getByRole('button', { name: `Resume ${PAUSEABLE}` }).click();
        await page.waitForURL(/\/watches$/u);
        expect(await cardFor(page, PAUSEABLE).textContent()).toContain('active');
      }),
    240_000,
  );

  it(
    'gives an account with no watches the empty state rather than a blank page',
    async () =>
      withPage(async (page) => {
        // The fixture's own account, which is seeded with an address and
        // nothing else.
        await openWatchesAs(page, stack.email);

        // Scoped to the page's own region rather than the document. The dev
        // server puts its tooling in the same body, including an empty
        // `role="alert"` live region it announces through, and a test that
        // counted that would be reporting on Next rather than on this page.
        const main = page.locator('main');
        // Whatever the page actually said, carried into the messages below: a
        // count that is wrong is only useful alongside what was counted.
        const rendered = (await main.textContent()) ?? '';

        expect(await main.getByRole('heading', { level: 1 }).textContent()).toBe('Watches');
        expect(rendered).toContain('No watches yet');
        expect(await main.getByRole('heading', { level: 2 }).allTextContents()).toEqual([]);
        // An empty account is not an error, and must not be reported as one.
        expect(await main.getByRole('alert').allTextContents(), rendered).toEqual([]);
      }),
    240_000,
  );
});

/** `toBeVisible` without `@playwright/test`'s expect, which this file does not use. */
async function expectVisible(locator: Locator): Promise<void> {
  expect(await locator.isVisible()).toBe(true);
}
