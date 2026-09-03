import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type {
  CalendarAnnotation,
  CalendarItemKind,
  CalendarItemStatus,
  TaskEventType,
  TaskKind,
  TaskMode,
  TaskStatus,
  WatchStatus,
} from '@chief-of-staff/core';
import {
  calendarItems,
  observations,
  runMigrations,
  taskEvents,
  tasks,
  users,
  watches,
} from '@chief-of-staff/db';
import { startTestPostgres, type TestPostgres } from '@chief-of-staff/db/testing';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../app.js';
import type { RecordingMailer } from '../auth/mailer.js';

/**
 * A real API, on a real database, with a real account in it — as one handle.
 *
 * This exists for the dashboard's end-to-end guard test, which has to drive a
 * browser through the whole magic-link flow and therefore needs a server that
 * actually issues links and actually verifies sessions. It cannot build one for
 * itself: `eslint.config.js` refuses `@chief-of-staff/db` anywhere under
 * `packages/web`, and rightly so — the dashboard reads its data over HTTP and
 * the API is the only door. So the door builds the fixture, and the dashboard
 * is handed a URL, which is exactly the amount of coupling the boundary allows.
 *
 * Source-only, like `packages/db/src/testing`: excluded from this package's
 * build, aliased for tests in `vitest.config.ts`, and never reachable from
 * `packages/api/src/index.ts`.
 */

/**
 * One watch to plant, described the way a test wants to talk about it rather
 * than the way the table stores it. Everything the schema demands and no page
 * displays - the extractor, the condition, the tier policy - is filled in here
 * so a test that cares about a sparkline does not have to invent a selector.
 */
export interface SeedWatch {
  /** What the watch is pointed at. The page prints it, so tests assert on it. */
  readonly url: string;
  readonly status?: WatchStatus;
  /**
   * Observation values, oldest first. Each becomes one row a minute after the
   * last, so the series has a real order for a sparkline to plot and a real
   * newest row for the page to call the last observation. Omitted means a watch
   * that has never been checked, which is its own page state.
   */
  readonly series?: readonly number[];
}

/** One planted watch, as the test now knows it. */
export interface SeededWatch {
  readonly id: string;
  readonly url: string;
  readonly status: WatchStatus;
  /** Exactly what was asked for, echoed back so assertions read off the seed. */
  readonly series: readonly number[];
}


/**
 * One calendar row to plant.
 *
 * The dates are the point. `GET /calendar-items` returns them ordered by name,
 * which is not the order a calendar is read in, so every test about ordering is
 * a test about what the page does with these two columns rather than what the
 * API handed it.
 */
export interface SeedCalendarItem {
  /** What the page prints, so tests assert on it. */
  readonly name: string;
  /** Defaults to `subscription`, the kind that renews rather than expires. */
  readonly kind?: CalendarItemKind;
  /** `YYYY-MM-DD`. A subscription's next charge. */
  readonly renewOn?: string;
  /** `YYYY-MM-DD`. The last day a deadline can still be acted on. */
  readonly cancelBy?: string;
  readonly amountCents?: number;
  readonly status?: CalendarItemStatus;
  /** The mark an engine left on the entry, with its note; unmarked by default. */
  readonly annotation?: CalendarAnnotation;
  readonly annotationNote?: string;
}

/** One planted calendar row, as the test now knows it. */
export interface SeededCalendarItem {
  readonly id: string;
  readonly name: string;
  readonly kind: CalendarItemKind;
  readonly renewOn: string | undefined;
  readonly cancelBy: string | undefined;
  readonly amountCents: number | undefined;
  readonly status: CalendarItemStatus;
}

/**
 * One task to plant, in the order it happened.
 *
 * Position in the array is the history: each row is created a minute after the
 * one before it, so `oldest first` here comes back `newest first` from the API,
 * and a page that reversed nothing is distinguishable from one that did.
 */
export interface SeedTask {
  readonly kind?: TaskKind;
  readonly status?: TaskStatus;
  readonly mode?: TaskMode;
  readonly input?: unknown;
  /** Where the task's recording is, for a task that has one. */
  readonly recordingUrl?: string;
  /** ISO; a task that has not finished has none. */
  readonly finishedAt?: string;
  /**
   * The task's trail, oldest first. Each event is written after the one before
   * it, so the sequence the ledger assigns follows the array, and a page that
   * shows them in any other order is distinguishable from one that does not.
   */
  readonly events?: readonly SeedTaskEvent[];
}

/** One event of a task's trail, as the engine would have written it. */
export interface SeedTaskEvent {
  readonly type: TaskEventType;
  readonly payload: unknown;
}

/** One planted task, as the test now knows it. */
export interface SeededTask {
  readonly id: string;
  readonly kind: TaskKind;
  readonly status: TaskStatus;
  readonly mode: TaskMode;
  /** ISO, anchored to the seed epoch, so an order assertion cannot be a race. */
  readonly createdAt: string;
}

/** One planted account and everything planted under it. */
export interface SeededAccount {
  readonly userId: string;
  readonly email: string;
  readonly watches: readonly SeededWatch[];
  readonly calendarItems: readonly SeededCalendarItem[];
  readonly tasks: readonly SeededTask[];
}

export interface SeedAccountOptions {
  readonly email: string;
  readonly watches?: readonly SeedWatch[];
  readonly calendarItems?: readonly SeedCalendarItem[];
  /** Oldest first; the API returns them newest first. */
  readonly tasks?: readonly SeedTask[];
}

export interface AuthStack {
  /** Where the API is listening, as a browser can reach it. */
  readonly url: string;
  /** The key this server signs sessions with, for a test that needs to forge one. */
  readonly sessionSecret: string;
  /** The seeded account a link can be requested for. */
  readonly userId: string;
  readonly email: string;
  /** The server itself, for the rare assertion that needs to inject rather than dial. */
  readonly app: FastifyInstance;
  /**
   * The most recent magic link the API was asked to mail, read the way a person
   * reads their inbox. `undefined` when nothing has been sent.
   */
  lastLink(): string | undefined;
  clearMail(): void;
  /**
   * Plants a second account with rows of its own.
   *
   * Every page proof needs at least two accounts, because the property that
   * matters most is the one a single-account fixture cannot express: that a
   * signed-in person sees their rows and nobody else's. A test that seeds one
   * user and asserts it sees three watches passes just as happily against a
   * page that ignores the session entirely.
   */
  seedAccount(options: SeedAccountOptions): Promise<SeededAccount>;
  stop(): Promise<void>;
}

export interface StartAuthStackOptions {
  /**
   * Where a consumed link should land, and where an unauthenticated page is
   * sent. The dashboard has to be bound to a known port before this is called,
   * because the two servers name each other and something has to go first.
   */
  readonly dashboardBaseUrl: string;
  /** The address the seeded account holds. Lower case, as the column is written. */
  readonly email?: string;
}

const HOST = '127.0.0.1';
const DEFAULT_EMAIL = 'owner@example.test';

/**
 * A loopback port nothing is listening on, obtained by listening on one and
 * stopping.
 *
 * The API has to know its own public origin before it boots — the link it mails
 * is built from it — so the port cannot be the ephemeral one `listen(0)` would
 * hand back afterwards. The window between releasing this port and binding it
 * is small and on loopback only; a collision would fail loudly at `listen`
 * rather than quietly, which is the failure mode worth having.
 */
export async function reserveLoopbackPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, HOST, () => {
      probe.removeListener('error', reject);
      resolve();
    });
  });
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

export async function startAuthStack(options: StartAuthStackOptions): Promise<AuthStack> {
  const email = options.email ?? DEFAULT_EMAIL;
  const postgres: TestPostgres = await startTestPostgres();
  let app: FastifyInstance | undefined;

  try {
    await runMigrations(postgres.connectionString);
    const port = await reserveLoopbackPort();
    app = createApp({
      DATABASE_URL: postgres.connectionString,
      HOST,
      PORT: String(port),
      LOG_LEVEL: 'silent',
      NODE_ENV: 'test',
      // Fixed rather than generated, so a test can mint a cookie the server
      // will accept without having to reach inside it.
      SESSION_SECRET: 'the-secret-this-stack-configured',
      API_PUBLIC_URL: `http://${HOST}:${String(port)}`,
      DASHBOARD_BASE_URL: options.dashboardBaseUrl,
    });
    await app.listen({ host: HOST, port });

    const [account] = await app.db.insert(users).values({ email }).returning({ id: users.id });
    if (account === undefined) throw new Error('the fixture account was not created');

    const mailer = app.mailer as RecordingMailer;
    const started = app;
    return {
      url: `http://${HOST}:${String(port)}`,
      sessionSecret: started.auth.sessionSecret,
      userId: account.id,
      email,
      app: started,
      lastLink: () => mailer.last()?.link,
      clearMail: () => {
        mailer.clear();
      },
      seedAccount: (seed) => seedAccountOn(started, seed),
      stop: async () => {
        try {
          await started.close();
        } finally {
          await postgres.stop();
        }
      },
    };
  } catch (error: unknown) {
    // A stack that failed half way still has to release what it took, or the
    // next file in the run inherits a bound port and a live cluster.
    await app?.close();
    await postgres.stop();
    throw error;
  }
}

/**
 * A fixed instant the seeded history hangs off, rather than `Date.now()`.
 *
 * Observation timestamps are the thing a sparkline orders by, so a test that
 * asserts an order is asserting about these. Anchoring them means a failure
 * says the page ordered wrongly, and never that two rows a fast machine wrote
 * inside the same millisecond came back in the order the database felt like.
 */
const SEED_EPOCH = Date.parse('2026-01-01T00:00:00.000Z');
const SEED_INTERVAL_MS = 60_000;

/**
 * The schema demands an extractor and a condition of every watch; no page in
 * this sprint reads either. They are shaped like the real thing so a row that
 * escapes into a later engine test is not nonsense, and named here once so a
 * test about a sparkline never has to mention a CSS selector.
 */
const SEED_EXTRACTOR = { kind: 'css', selector: '#price' };
const SEED_CONDITION = { kind: 'below', value: 100 };

async function seedAccountOn(
  app: FastifyInstance,
  options: SeedAccountOptions,
): Promise<SeededAccount> {
  const [account] = await app.db
    .insert(users)
    .values({ email: options.email })
    .returning({ id: users.id });
  if (account === undefined) throw new Error(`the account for ${options.email} was not created`);

  const planted: SeededWatch[] = [];
  for (const seed of options.watches ?? []) {
    const series = seed.series ?? [];
    const status = seed.status ?? 'active';
    // The newest observation and the watch's own `last_*` columns have to agree,
    // because the page reads the summary from the watch row and the sparkline
    // from the series. A fixture that let them drift would let a page that
    // reads the wrong one of the two still pass.
    const checkedAt = series.map(
      (_value, index) => new Date(SEED_EPOCH + index * SEED_INTERVAL_MS),
    );
    const newestAt = checkedAt.at(-1);
    const newestValue = series.at(-1);

    const [row] = await app.db
      .insert(watches)
      .values({
        userId: account.id,
        kind: 'price',
        url: seed.url,
        extractor: SEED_EXTRACTOR,
        condition: SEED_CONDITION,
        schedule: '0 * * * *',
        status,
        ...(newestValue === undefined ? {} : { lastValue: newestValue }),
        ...(newestAt === undefined ? {} : { lastCheckedAt: newestAt }),
      })
      .returning({ id: watches.id });
    if (row === undefined) throw new Error(`the watch for ${seed.url} was not created`);

    if (series.length > 0) {
      await app.db.insert(observations).values(
        series.map((value, index) => ({
          watchId: row.id,
          checkedAt: checkedAt[index] as Date,
          tierUsed: 'http' as const,
          value,
          triggered: false,
        })),
      );
    }

    planted.push({ id: row.id, url: seed.url, status, series });
  }

  const plantedCalendarItems: SeededCalendarItem[] = [];
  for (const seed of options.calendarItems ?? []) {
    const kind = seed.kind ?? 'subscription';
    const status = seed.status ?? 'active';
    const [row] = await app.db
      .insert(calendarItems)
      .values({
        userId: account.id,
        kind,
        name: seed.name,
        amountCents: seed.amountCents ?? null,
        renewOn: seed.renewOn ?? null,
        cancelBy: seed.cancelBy ?? null,
        action: null,
        status,
        annotation: seed.annotation ?? null,
        annotationNote: seed.annotationNote ?? null,
        annotatedAt: seed.annotation === undefined ? null : new Date(),
      })
      .returning({ id: calendarItems.id });
    if (row === undefined) throw new Error(`the calendar item ${seed.name} was not created`);

    plantedCalendarItems.push({
      id: row.id,
      name: seed.name,
      kind,
      renewOn: seed.renewOn,
      cancelBy: seed.cancelBy,
      amountCents: seed.amountCents,
      status,
    });
  }

  const plantedTasks: SeededTask[] = [];
  const taskSeeds = options.tasks ?? [];
  for (const [index, seed] of taskSeeds.entries()) {
    const kind = seed.kind ?? 'cancel';
    const status = seed.status ?? 'queued';
    const mode = seed.mode ?? 'playbook';
    // Anchored rather than left to `defaultNow()`: the history is read newest
    // first, and two rows a fast machine writes inside the same millisecond
    // would come back in whichever order the database felt like.
    const createdAt = new Date(SEED_EPOCH + index * SEED_INTERVAL_MS);

    const [row] = await app.db
      .insert(tasks)
      .values({
        userId: account.id,
        kind,
        input: seed.input ?? { note: seed.kind ?? 'cancel' },
        status,
        mode,
        createdAt,
        recordingUrl: seed.recordingUrl ?? null,
        finishedAt: seed.finishedAt === undefined ? null : new Date(seed.finishedAt),
      })
      .returning({ id: tasks.id });
    if (row === undefined) throw new Error(`the task at position ${String(index)} was not created`);

    for (const [position, event] of (seed.events ?? []).entries()) {
      // One insert per event, so the identity column hands out sequence
      // numbers in array order; the timestamps are anchored a second apart
      // for the same reason the rows are a minute apart.
      await app.db.insert(taskEvents).values({
        taskId: row.id,
        type: event.type,
        payload: event.payload,
        ts: new Date(createdAt.getTime() + (position + 1) * 1000),
      });
    }

    plantedTasks.push({ id: row.id, kind, status, mode, createdAt: createdAt.toISOString() });
  }

  return {
    userId: account.id,
    email: options.email,
    watches: planted,
    calendarItems: plantedCalendarItems,
    tasks: plantedTasks,
  };
}
