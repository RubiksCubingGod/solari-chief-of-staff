import { chromium, type Browser, type FrameLocator, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REQUEST_LINK_PATH } from './auth/session';
import { startWebDevServer, type WebDevServer } from './testing/dev-server';
import { startRecordingServer, type RecordingServer } from './testing/recording-server';

/**
 * The task detail page: the trail of one task, and the recording of it where
 * there is one, proven through a real browser against a real API and a seeded
 * database.
 *
 * The recording is a real rrweb capture of a fake gym cancellation, served by
 * a stand-in store in every encoding a store has been seen to use. A player
 * that shows the gym's page, and shows a different moment of it after the
 * reader scrubs, is playing the recording rather than a picture of one.
 */

interface SeededTask {
  readonly id: string;
  readonly kind: 'cancel' | 'book_slot' | 'custom';
  readonly status: string;
}

interface SeededAccount {
  readonly userId: string;
  readonly email: string;
  readonly tasks: readonly SeededTask[];
}

interface SeedEvent {
  readonly type: 'transition' | 'step' | 'ask_user' | 'user_reply' | 'rejected';
  readonly payload: unknown;
}

interface AuthStack {
  readonly url: string;
  readonly email: string;
  lastLink(): string | undefined;
  clearMail(): void;
  seedAccount(options: {
    readonly email: string;
    readonly tasks?: readonly {
      readonly kind?: 'cancel' | 'book_slot' | 'custom';
      readonly status?: string;
      readonly recordingUrl?: string;
      readonly finishedAt?: string;
      readonly events?: readonly SeedEvent[];
    }[];
  }): Promise<SeededAccount>;
  stop(): Promise<void>;
}

interface AuthStackModule {
  startAuthStack(options: { readonly dashboardBaseUrl: string }): Promise<AuthStack>;
  reserveLoopbackPort(): Promise<number>;
}

/** Loaded through a variable for the reason `calendar-tasks-pages.integration.test.ts` gives. */
const AUTH_STACK_MODULE = '@chief-of-staff/api/testing';

const QUESTION = 'The gym asks for a reason. What should I say?';
const REPLY = 'Moving away';
const ASKED = {
  questionId: 'b8d0d3a2-4c1e-4d7a-9a3e-2f1c5b6d7e80',
  question: QUESTION,
  askedAt: '2026-08-30T10:00:05.000Z',
  expiresAt: '2026-08-30T22:00:05.000Z',
} as const;

/**
 * A trail with every kind of event in it, written in the order the engine
 * would write it. The page must show it in exactly this order: a reader who
 * sees the reply before the question, or the finish before the start, has
 * been told a different story.
 */
const RICH_TRAIL: readonly SeedEvent[] = [
  { type: 'transition', payload: { from: 'queued', to: 'running', cause: 'started', detail: null } },
  { type: 'step', payload: { name: 'open_site', outcome: 'ok' } },
  { type: 'ask_user', payload: ASKED },
  { type: 'transition', payload: { from: 'running', to: 'waiting_user', cause: 'asked', detail: null } },
  { type: 'user_reply', payload: { questionId: ASKED.questionId, reply: REPLY, answeredAt: '2026-08-30T10:04:00.000Z' } },
  { type: 'transition', payload: { from: 'waiting_user', to: 'running', cause: 'answered', detail: null } },
  { type: 'step', payload: { name: 'submit_cancellation', outcome: 'ok' } },
  { type: 'transition', payload: { from: 'running', to: 'succeeded', cause: 'succeeded', detail: null } },
];

const PARKED_TRAIL: readonly SeedEvent[] = [
  { type: 'transition', payload: { from: 'queued', to: 'running', cause: 'started', detail: null } },
  { type: 'ask_user', payload: ASKED },
  { type: 'transition', payload: { from: 'running', to: 'waiting_user', cause: 'asked', detail: null } },
];

let stack: AuthStack;
let web: WebDevServer;
let browser: Browser;
let recordings: RecordingServer;
let planner: SeededAccount;
let bystander: SeededAccount;
/** Planner's tasks by role, in the order they were seeded. */
let rich: SeededTask;
let bare: SeededTask;
let corrupt: SeededTask;
let unfetchable: SeededTask;
let parked: SeededTask;

beforeAll(async () => {
  const module = (await import(AUTH_STACK_MODULE)) as AuthStackModule;
  const port = await module.reserveLoopbackPort();
  const dashboardBaseUrl = `http://127.0.0.1:${String(port)}`;

  recordings = await startRecordingServer();
  stack = await module.startAuthStack({ dashboardBaseUrl });
  web = await startWebDevServer({ apiBaseUrl: stack.url, port });
  browser = await chromium.launch();

  planner = await stack.seedAccount({
    email: 'planner@example.test',
    tasks: [
      {
        kind: 'cancel',
        status: 'succeeded',
        recordingUrl: recordings.gzip,
        finishedAt: '2026-08-30T10:05:00.000Z',
        events: RICH_TRAIL,
      },
      { kind: 'custom', status: 'succeeded', events: [RICH_TRAIL[0] as SeedEvent] },
      { kind: 'cancel', status: 'succeeded', recordingUrl: recordings.corrupt, events: RICH_TRAIL },
      { kind: 'cancel', status: 'succeeded', recordingUrl: recordings.missing, events: RICH_TRAIL },
      { kind: 'book_slot', status: 'waiting_user', events: PARKED_TRAIL },
    ],
  });
  [rich, bare, corrupt, unfetchable, parked] = planner.tasks as [
    SeededTask,
    SeededTask,
    SeededTask,
    SeededTask,
    SeededTask,
  ];
  bystander = await stack.seedAccount({
    email: 'bystander@example.test',
    tasks: [{ kind: 'custom', recordingUrl: recordings.plain, events: RICH_TRAIL }],
  });
}, 300_000);

afterAll(async () => {
  await browser.close();
  await web.stop();
  await stack.stop();
  await recordings.stop();
});

/** Signs a browser in the way a person does. */
async function signIn(page: Page, address: string): Promise<void> {
  stack.clearMail();
  await page.goto(`${web.url}${REQUEST_LINK_PATH}`);
  await page.getByLabel('Email address').fill(address);
  await page.getByRole('button', { name: /sign-in link/iu }).click();
  await page.waitForURL(/\/login\?sent=1$/u);

  const link = stack.lastLink();
  expect(link, `no sign-in link was mailed to ${address}`).toBeDefined();
  await page.goto(link ?? '');
}

/** Opens one task's page and reports the status the dashboard answered with. */
async function openTask(page: Page, address: string, task: SeededTask): Promise<number> {
  await signIn(page, address);
  const response = await page.goto(`${web.url}/tasks/${task.id}`);
  return response?.status() ?? 0;
}

function timeline(page: Page): Locator {
  return page.getByRole('list', { name: 'Timeline' }).getByRole('listitem');
}

function player(page: Page): Locator {
  return page.locator('.rr-player');
}

/** The replayed page itself: the recorded site, rebuilt inside the player's frame. */
function replayed(page: Page): FrameLocator {
  return page.frameLocator('.rr-player iframe');
}

/** Seeks to a fraction of the recording by clicking the progress bar where a person would. */
async function scrubTo(page: Page, fraction: number): Promise<void> {
  const bar = page.locator('.rr-progress');
  const box = await bar.boundingBox();
  if (box === null) throw new Error('the player has no progress bar to scrub');
  // Through the locator rather than the mouse, so the bar is scrolled into
  // view first: below the facts and the frame it sits under the fold.
  await bar.click({ position: { x: box.width * fraction, y: box.height / 2 } });
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

describe('the task detail page', () => {
  it(
    'is reached from the task history and tells the trail in the order it was written',
    async () =>
      withPage(async (page) => {
        await signIn(page, planner.email);
        await page.goto(`${web.url}/tasks`);
        await page.locator(`a[href="/tasks/${rich.id}"]`).click();
        await page.waitForURL(`${web.url}/tasks/${rich.id}`);

        expect(await page.getByRole('heading', { level: 1 }).textContent()).toContain('cancel');
        expect(await page.locator('body').textContent()).toContain('succeeded');

        const entries = await timeline(page).allTextContents();
        expect(entries).toHaveLength(RICH_TRAIL.length);
        // Written out, one line per seeded event, in seeded order: a page that
        // sorted newest first, or dropped the kinds it did not recognise,
        // cannot pass.
        const expected: readonly (readonly string[])[] = [
          ['queued', 'running'],
          ['open_site', 'ok'],
          [QUESTION],
          ['running', 'waiting_user'],
          [REPLY],
          ['waiting_user', 'running'],
          ['submit_cancellation', 'ok'],
          ['running', 'succeeded'],
        ];
        expected.forEach((words, index) => {
          for (const word of words) {
            expect(entries[index], `timeline entry ${String(index)}`).toContain(word);
          }
        });
      }),
    240_000,
  );

  it(
    'plays the recording and shows a different moment of it after the reader scrubs',
    async () =>
      withPage(async (page) => {
        expect(await openTask(page, planner.email, rich)).toBe(200);
        await player(page).waitFor({ state: 'visible', timeout: 60_000 });

        const gym = replayed(page);
        await gym.getByRole('heading', { name: 'Fake Gym' }).waitFor({ timeout: 30_000 });
        // The recording is 1.3 s long and plays on its own: it ends cancelled.
        await gym.getByText('Cancellation confirmed.').waitFor({ timeout: 30_000 });

        // Back to the opening frames: the membership is still active and
        // nothing has been confirmed. Only a player that re-renders the
        // recorded DOM at the sought moment can show this.
        await scrubTo(page, 0.02);
        await gym.locator('#status', { hasText: 'Membership: active' }).waitFor({ timeout: 10_000 });
        expect(await gym.locator('#done').count()).toBe(0);

        // And forward again.
        await scrubTo(page, 0.98);
        await gym.getByText('Cancellation confirmed.').waitFor({ timeout: 10_000 });
        expect(await gym.locator('#status').textContent()).toContain('cancelled');
      }),
    240_000,
  );

  it(
    'says plainly when there is no recording, and still tells the trail',
    async () =>
      withPage(async (page) => {
        expect(await openTask(page, planner.email, bare)).toBe(200);

        await page.getByText('No recording available').waitFor({ timeout: 30_000 });
        expect(await player(page).count()).toBe(0);
        expect(await timeline(page).count()).toBe(1);
      }),
    240_000,
  );

  it(
    'shows a replay error rather than a broken page when the recording is corrupt or cannot be fetched',
    async () =>
      withPage(async (page) => {
        expect(await openTask(page, planner.email, corrupt)).toBe(200);
        // Filtered to the player's own sentence: the dev server's overlay
        // carries an empty live region of the same role.
        const corruptAlert = page.getByRole('alert').filter({ hasText: /recording/u });
        await corruptAlert.waitFor({ timeout: 60_000 });
        expect(await corruptAlert.textContent()).toMatch(/could not be played/u);
        expect(await timeline(page).count()).toBe(RICH_TRAIL.length);

        const response = await page.goto(`${web.url}/tasks/${unfetchable.id}`);
        expect(response?.status()).toBe(200);
        const missingAlert = page.getByRole('alert').filter({ hasText: /recording/u });
        await missingAlert.waitFor({ timeout: 60_000 });
        expect(await missingAlert.textContent()).toMatch(/could not be fetched/u);
        expect(await timeline(page).count()).toBe(RICH_TRAIL.length);
      }),
    240_000,
  );

  it(
    'shows the question a parked task is waiting on',
    async () =>
      withPage(async (page) => {
        expect(await openTask(page, planner.email, parked)).toBe(200);

        const pending = page.getByRole('status');
        await pending.waitFor({ timeout: 30_000 });
        expect(await pending.textContent()).toContain(QUESTION);
        expect(await page.locator('body').textContent()).toContain('waiting_user');
      }),
    240_000,
  );

  it(
    "answers a stranger's task as one that does not exist",
    async () =>
      withPage(async (page) => {
        const strangers = bystander.tasks[0] as SeededTask;

        expect(await openTask(page, planner.email, strangers)).toBe(404);
        expect(await page.locator('body').textContent()).not.toContain(QUESTION);
      }),
    240_000,
  );
});
