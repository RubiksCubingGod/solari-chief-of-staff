import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REQUEST_LINK_PATH } from './auth/session';
import { API_BASE_URL_VARIABLE } from './config';
import { startWebDevServer, type WebDevServer } from './testing/dev-server';
import { withEnvironmentVariable } from './testing/environment';

/**
 * The calendar and task pages, proven against the seed rather than a screenshot.
 *
 * Both are read surfaces, so the properties worth a browser are the ones that
 * only exist once a real API has answered a real session: what order the rows
 * come out in, whose rows they are, and what is shown when there is nothing to
 * show. The API returns calendar items in *name* order, so every ordering
 * assertion here is about what the page did with the dates rather than about
 * what it was handed.
 */

interface SeededCalendarItem {
  readonly id: string;
  readonly name: string;
  readonly kind: 'subscription' | 'deadline';
  readonly renewOn: string | undefined;
  readonly cancelBy: string | undefined;
  readonly amountCents: number | undefined;
  readonly status: 'active' | 'done';
}

interface SeededTask {
  readonly id: string;
  readonly kind: 'cancel' | 'book_slot' | 'custom';
  readonly status: string;
  readonly mode: string;
  readonly createdAt: string;
}

interface SeededAccount {
  readonly userId: string;
  readonly email: string;
  readonly calendarItems: readonly SeededCalendarItem[];
  readonly tasks: readonly SeededTask[];
}

interface AuthStack {
  readonly url: string;
  readonly email: string;
  lastLink(): string | undefined;
  clearMail(): void;
  seedAccount(options: {
    readonly email: string;
    readonly calendarItems?: readonly {
      readonly name: string;
      readonly kind?: 'subscription' | 'deadline';
      readonly renewOn?: string;
      readonly cancelBy?: string;
      readonly amountCents?: number;
    }[];
    readonly tasks?: readonly {
      readonly kind?: 'cancel' | 'book_slot' | 'custom';
      readonly status?: string;
    }[];
  }): Promise<SeededAccount>;
  stop(): Promise<void>;
}

interface AuthStackModule {
  startAuthStack(options: { readonly dashboardBaseUrl: string }): Promise<AuthStack>;
  reserveLoopbackPort(): Promise<number>;
}

/**
 * Loaded through a variable rather than a literal, for the same reason
 * `watches-page.integration.test.ts` does it: this package's TypeScript project
 * resolves like the bundler that builds it and its lint boundary keeps it away
 * from the database, so a written-out specifier fails the type check even
 * though the runner resolves it perfectly.
 */
const AUTH_STACK_MODULE = '@chief-of-staff/api/testing';

/**
 * Three calendar rows whose alphabetical order and whose date order disagree at
 * every position. Name order is Adobe, Mystery, Zoom; date order is Zoom
 * (March), Adobe (December), Mystery (undated, last). A page that printed what
 * the API handed it cannot pass, and neither can one that sorted on the wrong
 * column.
 */
const ZOOM = { name: 'Zoom trial', kind: 'deadline', cancelBy: '2026-03-15' } as const;
const ADOBE = {
  name: 'Adobe Creative Cloud',
  kind: 'subscription',
  renewOn: '2026-12-01',
  amountCents: 2399,
  // Marked the way the worker marks an entry it could not act on, so the page
  // is proven to show the mark and the reason.
  annotation: 'needs_attention',
  annotationNote:
    'Auto-cancel could not be armed for the renewal on 2026-12-01: no connected site for gym.example.test.',
} as const;
const MYSTERY = { name: 'Mystery charge', kind: 'subscription' } as const;

/** Oldest first, so the page - which reads newest first - must reverse them. */
const TASK_HISTORY = [
  { kind: 'cancel', status: 'succeeded' },
  { kind: 'book_slot', status: 'waiting_user' },
  { kind: 'custom', status: 'failed' },
] as const;

const SOMEBODY_ELSES_ITEM = 'Not yours';

let stack: AuthStack;
let web: WebDevServer;
let browser: Browser;
let planner: SeededAccount;
let bystander: SeededAccount;
/** A port nothing is listening on, so a request to it is refused immediately. */
let deadApiUrl: string;

beforeAll(async () => {
  const module = (await import(AUTH_STACK_MODULE)) as AuthStackModule;
  const port = await module.reserveLoopbackPort();
  const dashboardBaseUrl = `http://127.0.0.1:${String(port)}`;
  deadApiUrl = `http://127.0.0.1:${String(await module.reserveLoopbackPort())}`;

  stack = await module.startAuthStack({ dashboardBaseUrl });
  web = await startWebDevServer({ apiBaseUrl: stack.url, port });
  browser = await chromium.launch();

  planner = await stack.seedAccount({
    email: 'planner@example.test',
    calendarItems: [ADOBE, MYSTERY, ZOOM],
    tasks: [...TASK_HISTORY],
  });
  bystander = await stack.seedAccount({
    email: 'bystander@example.test',
    calendarItems: [{ name: SOMEBODY_ELSES_ITEM, renewOn: '2026-02-01' }],
    tasks: [{ kind: 'custom' }],
  });
}, 300_000);

afterAll(async () => {
  await browser.close();
  await web.stop();
  await stack.stop();
});

/** Signs a browser in the way a person does, then opens one section. */
async function openAs(page: Page, address: string, path: string): Promise<void> {
  stack.clearMail();
  await page.goto(`${web.url}${REQUEST_LINK_PATH}`);
  await page.getByLabel('Email address').fill(address);
  await page.getByRole('button', { name: /sign-in link/iu }).click();
  await page.waitForURL(/\/login\?sent=1$/u);

  const link = stack.lastLink();
  expect(link, `no sign-in link was mailed to ${address}`).toBeDefined();
  await page.goto(link ?? '');
  await page.goto(`${web.url}${path}`);
  // A redirect back to sign-in would otherwise surface as "element not found".
  expect(new URL(page.url()).pathname).toBe(path);
}

/** The card for one row, found by the name it is headed with. */
function cardFor(page: Page, name: string): Locator {
  return page.locator('article').filter({ has: page.getByRole('heading', { name }) });
}

async function withPage<T>(run: (page: Page) => Promise<T>): Promise<T> {
  // A context per test, so a session left behind by one test is never what
  // makes the next one pass.
  const context = await browser.newContext();
  try {
    return await run(await context.newPage());
  } finally {
    await context.close();
  }
}

describe('the calendar page', () => {
  it(
    'files every row under its own date, soonest first, whatever order the API used',
    async () =>
      withPage(async (page) => {
        await openAs(page, planner.email, '/calendar');

        const headings = await page.getByRole('heading', { level: 2 }).allTextContents();
        // Written out rather than sorted here: a test that re-ran the page's
        // own sort would pass against any sort at all.
        expect(headings).toEqual([ZOOM.name, ADOBE.name, MYSTERY.name]);
      }),
    240_000,
  );

  it(
    'says what each date means, and shows an amount only where one was recorded',
    async () =>
      withPage(async (page) => {
        await openAs(page, planner.email, '/calendar');

        const deadline = (await cardFor(page, ZOOM.name).textContent()) ?? '';
        expect(deadline).toContain('Deadline');
        expect(deadline).toContain(ZOOM.cancelBy);
        // A deadline is not a renewal, and a badge that said both would be
        // telling the reader nothing.
        expect(deadline).not.toContain('Renewal');

        const renewal = (await cardFor(page, ADOBE.name).textContent()) ?? '';
        expect(renewal).toContain('Renewal');
        expect(renewal).toContain(ADOBE.renewOn);
        // Integer cents, printed as the amount they are.
        expect(renewal).toContain('23.99');

        // An undated, unpriced row is still a row: it is shown saying so rather
        // than dropped, because a charge nobody has dated is the one most worth
        // seeing.
        const undated = (await cardFor(page, MYSTERY.name).textContent()) ?? '';
        expect(undated).toContain('no date');
        expect(undated).toContain('not recorded');
      }),
    240_000,
  );

  it(
    'shows the mark the worker left on an entry with its reason, and nothing on an entry it left alone',
    async () =>
      withPage(async (page) => {
        await openAs(page, planner.email, '/calendar');

        const marked = (await cardFor(page, ADOBE.name).textContent()) ?? '';
        expect(marked).toContain('Needs attention');
        expect(marked).toContain(ADOBE.annotationNote);

        // The words for a mark appear only where there is one: a page that
        // said "Needs attention" on every card would be crying wolf.
        const plain = (await cardFor(page, ZOOM.name).textContent()) ?? '';
        expect(plain).not.toContain('Needs attention');
      }),
    240_000,
  );

  it(
    'never shows another account its neighbour rows',
    async () =>
      withPage(async (page) => {
        await openAs(page, bystander.email, '/calendar');

        const headings = await page.getByRole('heading', { level: 2 }).allTextContents();
        expect(headings).toEqual([SOMEBODY_ELSES_ITEM]);
        expect(await page.locator('body').textContent()).not.toContain(ADOBE.name);
      }),
    240_000,
  );

  it(
    'gives an account with nothing on it the empty state rather than a blank page',
    async () =>
      withPage(async (page) => {
        await openAs(page, stack.email, '/calendar');

        const main = page.locator('main');
        const rendered = (await main.textContent()) ?? '';

        expect(await main.getByRole('heading', { level: 1 }).textContent()).toBe('Calendar');
        expect(rendered).toContain('Nothing on the calendar yet');
        expect(await main.getByRole('heading', { level: 2 }).allTextContents()).toEqual([]);
        // Scoped to the page's own region: the dev server keeps an empty
        // `role="alert"` live region in the same body, and counting that would
        // be reporting on Next rather than on this page.
        expect(await main.getByRole('alert').allTextContents(), rendered).toEqual([]);
      }),
    240_000,
  );
});

describe('the task history page', () => {
  it(
    'lists every run newest first, with what became of it',
    async () =>
      withPage(async (page) => {
        await openAs(page, planner.email, '/tasks');

        const headings = await page.getByRole('heading', { level: 2 }).allTextContents();
        expect(headings).toEqual([...TASK_HISTORY].reverse().map((task) => task.kind));

        for (const seeded of TASK_HISTORY) {
          expect(await cardFor(page, seeded.kind).textContent()).toContain(seeded.status);
        }
      }),
    240_000,
  );

  it(
    'links each run to the detail page s5 will build',
    async () =>
      withPage(async (page) => {
        await openAs(page, planner.email, '/tasks');

        // Read off the seed: the row a reader clicks has to be the row the
        // detail page will open, and an id from anywhere but the seeded task
        // would be a link to somebody else's run or to nothing at all.
        for (const seeded of planner.tasks) {
          expect(
            await cardFor(page, seeded.kind).getByRole('link').getAttribute('href'),
            `the ${seeded.kind} row`,
          ).toBe(`/tasks/${seeded.id}`);
        }
      }),
    240_000,
  );

  it(
    'gives an account with no runs the empty state rather than a blank page',
    async () =>
      withPage(async (page) => {
        await openAs(page, stack.email, '/tasks');

        const main = page.locator('main');
        const rendered = (await main.textContent()) ?? '';

        expect(await main.getByRole('heading', { level: 1 }).textContent()).toBe('Tasks');
        expect(rendered).toContain('No tasks yet');
        expect(await main.getByRole('heading', { level: 2 }).allTextContents()).toEqual([]);
        expect(await main.getByRole('alert').allTextContents(), rendered).toEqual([]);
      }),
    240_000,
  );
});

describe('every page when the API is not answering', () => {
  it(
    'tells the reader the section could not be loaded, rather than showing an empty one',
    async () =>
      withPage(async (page) => {
        // Signed in first, against the real API, so what is proven below is a
        // page failing rather than a session that never existed.
        await openAs(page, planner.email, '/calendar');

        // A genuine outage rather than a stub: the dashboard runs in this
        // process and reads `API_BASE_URL` per request, so pointing it at a
        // port nothing is listening on makes every server component's fetch
        // fail exactly the way it fails when the API is down.
        const restore = withEnvironmentVariable(API_BASE_URL_VARIABLE, deadApiUrl);
        try {
          for (const [path, sentence] of [
            ['/watches', 'Your watches could not be loaded'],
            ['/calendar', 'Your calendar could not be loaded'],
            ['/tasks', 'Your tasks could not be loaded'],
          ] as const) {
            await page.goto(`${web.url}${path}`);
            const shown = (
              await page.locator('main').getByRole('alert').allTextContents()
            ).join(' ');

            expect(shown, `${path} said: ${shown}`).toContain(sentence);
            // The reason, not merely that there was one. "Could not be loaded"
            // with no cause is the page telling the reader to guess.
            expect(shown, `${path} said: ${shown}`).toContain('the API did not answer');
            // And no empty state beside it, which would be the page claiming
            // the account has nothing when it does not know either way.
            const rendered = (await page.locator('main').textContent()) ?? '';
            expect(rendered, `${path} rendered: ${rendered}`).not.toContain('yet.');
          }
        } finally {
          restore();
        }

        // The outage was the environment's, not the page's: with the API back,
        // the same server draws the same page without being restarted.
        await page.goto(`${web.url}/calendar`);
        expect(await page.locator('main').getByRole('alert').allTextContents()).toEqual([]);
      }),
    240_000,
  );
});
