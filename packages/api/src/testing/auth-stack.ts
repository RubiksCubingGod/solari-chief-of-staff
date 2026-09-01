import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { runMigrations, users } from '@chief-of-staff/db';
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
