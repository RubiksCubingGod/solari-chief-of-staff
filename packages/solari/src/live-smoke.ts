import { setTimeout as delay } from 'node:timers/promises';

import { createSolariClient, createSolariProvider } from './solari.js';
import { withBrowser, type BrowserProvider } from './provider.js';

/**
 * The live smoke: the one path in this package that spends real vendor credit.
 *
 * It exists because everything else here is proven against a fake. The seam's
 * contract suite drives a local Chromium, and the Solari adapter's unit tests
 * inject a client — both are honest about what they cover, and neither would
 * notice the vendor changing a status code, a field name, or the shape of a
 * replay. This is the early-warning line for that, which is why it runs on a
 * schedule rather than on a push.
 */

/** The Actions secret, and the local `.env` key, the smoke authenticates with. */
export const API_KEY_VARIABLE = 'SOLARI_API_KEY';

/**
 * The explicit opt-in.
 *
 * A key on its own is not consent to spend it. Without this flag the suite
 * skips even on a machine whose `.env` holds a valid key, so an ordinary
 * `pnpm check` never bills anyone. It is the reason the live file can sit in
 * the ordinary `integration` project without being excluded from it: the run
 * collects the suite and skips it, which keeps the file typechecked, linted,
 * and loadable rather than quietly rotting behind a config exclusion.
 */
export const LIVE_SMOKE_FLAG = 'SOLARI_LIVE_SMOKE';

/**
 * The values that count as "yes".
 *
 * Deliberately a list rather than a truthiness test: `SOLARI_LIVE_SMOKE=0`
 * reads as "no" to every human who writes it, and honouring the string's
 * truthiness instead of its meaning would bill them for the misunderstanding.
 */
const OPT_IN_VALUES: ReadonlySet<string> = new Set(['1', 'true', 'yes', 'on']);

/** The page the smoke loads. A cloud browser cannot reach localhost, so fixtures are out. */
export const SMOKE_URL = 'https://example.com';

/** rrweb batches events; this is the pause that lets the last batch flush before release. */
export const RRWEB_FLUSH_MS = 2_000;

/** The replay is not addressable the instant a session releases; it 404s first. */
export const REPLAY_POLL_TIMEOUT_MS = 30_000;
export const REPLAY_POLL_INTERVAL_MS = 1_000;

/**
 * What the replay body turned out to be once Node's `fetch` was done with it.
 *
 * **Observed, against the real gateway:** the API reports
 * `contentEncoding: "gzip"`, the presigned response *also* carries
 * `content-encoding: gzip` on the wire, and undici transparently inflates it.
 * A caller using Node's `fetch` therefore receives plain NDJSON — 2427 bytes
 * for a single `example.com` visit — and must **not** gunzip it. A caller using
 * a client that does not auto-decompress gets the gzip stream instead.
 *
 * This is worth a type and an assertion rather than a comment alone because
 * both ways of being wrong are quiet: gunzipping the inflated body fails on
 * bytes that are already text, and parsing the raw stream as text yields
 * plausible-looking garbage. {@link runLiveSmoke} reports which one arrived and
 * the live suite pins it, so the day the vendor stops setting the header is the
 * day the nightly says so.
 */
export type ReplayBodyShape = 'gzip' | 'ndjson';

export interface LiveSmokeReport {
  readonly sessionId: string;
  readonly title: string;
  readonly replayUrl: string;
  /** How many `getReplayUrl` calls it took, including the 404s. */
  readonly replayAttempts: number;
  /** What the API says the stored object is encoded as. */
  readonly replayContentEncoding: string;
  /** What the presigned response actually declared on the wire, if anything. */
  readonly replayResponseEncoding: string | undefined;
  /** What arrived after undici was finished with it. See {@link ReplayBodyShape}. */
  readonly replayBodyShape: ReplayBodyShape;
  readonly replayBytes: number;
  /** Must be empty. A non-empty ledger after a released session is a leaked slot. */
  readonly liveSessionIdsAfterRelease: readonly string[];
}

export interface LiveSmokeOptions {
  readonly apiKey: string;
  readonly url?: string;
  readonly flushMs?: number;
  readonly onTeardownFailure?: TeardownFailureSink;
}

/**
 * Why the live smoke should not run, or `undefined` when it should.
 *
 * Returning a *reason* rather than a boolean is the point: the spec forbids a
 * silent green, so every caller has a sentence to print. Taking the environment
 * as an argument rather than reading `process.env` is the other half — the
 * decision that governs whether money is spent is a pure function, so it can be
 * pinned down in a unit test instead of discovered on a billing statement.
 */
export function liveSmokeSkipReason(env: Record<string, string | undefined>): string | undefined {
  const flag = (env[LIVE_SMOKE_FLAG] ?? '').trim().toLowerCase();
  if (!OPT_IN_VALUES.has(flag)) {
    return `${LIVE_SMOKE_FLAG} is not set to an opt-in value (1, true, yes, on), so the live Solari smoke was skipped rather than billed.`;
  }

  const apiKey = (env[API_KEY_VARIABLE] ?? '').trim();
  if (apiKey === '') {
    return `${API_KEY_VARIABLE} is not configured, so the live Solari smoke was skipped. Set it as a repository secret in CI, or in .env locally.`;
  }

  return undefined;
}

/** The HTTP status that means "the replay is not written yet", as opposed to "never will be". */
const REPLAY_NOT_READY = 404;

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { status } = error as { status?: unknown };
  return typeof status === 'number' ? status : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ReplayLocation {
  readonly url: string;
  readonly contentEncoding: string;
  readonly attempts: number;
}

/**
 * The one thing the poll needs from a vendor client.
 *
 * Narrowed to a method rather than taking the client, so the 404-window logic
 * can be driven from a unit test instead of only ever being exercised by the
 * nightly. `SessionsResource` satisfies it structurally.
 */
export interface ReplayReader {
  getReplayUrl(id: string): Promise<{ url: string; contentEncoding: string }>;
}

/**
 * What the smoke needs from a vendor client: somewhere to read replays from,
 * and the `close()` that stops the local proxy thread.
 *
 * Structural for the same reason {@link ReplayReader} is. The composition in
 * {@link runLiveSmokeWith} is otherwise reachable only with a billed
 * credential, which would leave the teardown it exists to prove uncovered by
 * `pnpm check` - the one run that would notice it regressing. `Solari`
 * satisfies it, and naming the shape here rather than importing the vendor type
 * keeps the single-importer boundary intact.
 */
export interface ReplayClient {
  readonly sessions: ReplayReader;
  close(): Promise<void>;
}

/**
 * The three things {@link runLiveSmokeWith} cannot build for itself without
 * spending money. Passed explicitly rather than as optional overrides on
 * {@link LiveSmokeOptions}: a defaulted `??` puts the real vendor call on one
 * side of a branch no test can take, so the seam would cost coverage on the
 * very path it was added to cover.
 */
export interface LiveSmokeDependencies {
  readonly provider: BrowserProvider;
  readonly replayClient: ReplayClient;
  readonly probeBody: (url: string) => Promise<ReplayBody>;
}

/** What {@link expiresIn} resolves to when the window closes first. */
const EXPIRED = 'expired';

/**
 * A timer that loses its race silently.
 *
 * `Promise.race` settles on the winner but does not cancel the loser, so a
 * plain rejecting timer becomes an unhandled rejection every time the work it
 * guards arrives first. Cancelling leaves it permanently pending instead, which
 * is the correct shape for a loser nobody is waiting on any more.
 */
function expiresIn(ms: number): { readonly expired: Promise<typeof EXPIRED>; readonly cancel: () => void } {
  const controller = new AbortController();
  const expired = delay<typeof EXPIRED>(ms, EXPIRED, { signal: controller.signal }).catch(
    () => new Promise<never>(() => undefined),
  );

  return {
    expired,
    cancel: () => {
      controller.abort();
    },
  };
}

export interface ReplayPollOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}

/**
 * Poll `getReplayUrl` through its 404 window.
 *
 * Only a 404 is retried. Anything else — an expired key, a session id the
 * gateway rejects — is a standing condition, and spending thirty seconds
 * rediscovering it would bury the real error under a timeout.
 *
 * The window is real and not defensive padding: a live run took four attempts
 * before the replay was addressable.
 */
export async function pollReplayUrl(
  reader: ReplayReader,
  sessionId: string,
  options: ReplayPollOptions = {},
): Promise<ReplayLocation> {
  const timeoutMs = options.timeoutMs ?? REPLAY_POLL_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? REPLAY_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastError: unknown = new Error(
    `no attempt completed inside the ${String(timeoutMs)}ms window`,
  );

  for (;;) {
    attempts += 1;
    const remaining = deadline - Date.now();

    if (remaining > 0) {
      // Race the attempt against what is left of the window. Checking the
      // deadline only *between* attempts is how a poll that promises thirty
      // seconds spends ninety inside one hung call to a vendor that never
      // answers, and the caller who read the constant is none the wiser.
      const timer = expiresIn(remaining);
      try {
        const outcome = await Promise.race([
          reader.getReplayUrl(sessionId).then((found) => ({ found }) as const),
          timer.expired,
        ]);

        if (outcome !== EXPIRED) {
          return { url: outcome.found.url, contentEncoding: outcome.found.contentEncoding, attempts };
        }
        lastError = new Error(`attempt ${String(attempts)} was still in flight when the window closed`);
      } catch (error) {
        if (statusOf(error) !== REPLAY_NOT_READY) throw error;
        lastError = error;
      } finally {
        timer.cancel();
      }
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `the replay for session ${sessionId} was still absent after ${String(attempts)} attempts over ${String(timeoutMs)}ms: ${describeError(lastError)}`,
      );
    }
    await delay(intervalMs);
  }
}

export interface ReplayBody {
  readonly shape: ReplayBodyShape;
  readonly responseEncoding: string | undefined;
  readonly bytes: number;
}

/** The gzip magic number. Two bytes is all it takes to answer the encoding question. */
const GZIP_MAGIC = [0x1f, 0x8b] as const;

/**
 * Fetch the presigned replay and record what actually came back.
 *
 * This is the observation the research could not settle from documentation, so
 * the smoke makes it every night and the report carries the answer.
 */
export async function probeReplayBody(url: string): Promise<ReplayBody> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`the presigned replay URL answered ${String(response.status)}`);
  }

  const responseEncoding = response.headers.get('content-encoding') ?? undefined;
  const body = new Uint8Array(await response.arrayBuffer());
  const gzipped = body[0] === GZIP_MAGIC[0] && body[1] === GZIP_MAGIC[1];

  return { shape: gzipped ? 'gzip' : 'ndjson', responseEncoding, bytes: body.byteLength };
}

/** One thing that has to be undone, and the name to blame when undoing it fails. */
export interface Teardown {
  readonly what: string;
  readonly run: () => Promise<void>;
}

export interface TeardownFailure {
  readonly what: string;
  readonly error: unknown;
}

export type TeardownFailureSink = (failure: TeardownFailure) => void;

/** Writes to stderr, so an unreported teardown failure is visible by default. */
export const reportTeardownFailureToConsole: TeardownFailureSink = ({ what, error }) => {
  console.error(`the live smoke could not complete ${what}`, error);
};

/**
 * Run every teardown, whichever of them fail, and hand the failures back.
 *
 * The naive shape — `await dispose(); await close();` in a `finally` — has two
 * bugs and they compound. A throwing `dispose()` never reaches `close()`, so
 * the SDK's local proxy thread outlives the work and the Node process hangs
 * rather than exiting: in CI that is a twenty-minute timeout wearing the wrong
 * failure's name. And because it throws *out of the finally*, it replaces
 * whatever the body was failing with, which is the error someone could have
 * acted on.
 *
 * Failures come back rather than being thrown because who should win depends on
 * why we are tearing down, and only the caller knows that. Sequential, not
 * `allSettled`: `dispose()` releases the session and `close()` stops the proxy
 * that was serving it, and that order is the one {@link withBrowser} and the
 * session-hygiene spec both describe.
 */
export async function runTeardowns(teardowns: readonly Teardown[]): Promise<TeardownFailure[]> {
  const failures: TeardownFailure[] = [];

  for (const teardown of teardowns) {
    try {
      await teardown.run();
    } catch (error) {
      failures.push({ what: teardown.what, error });
    }
  }

  return failures;
}

/** The tag the `@live` tier is selected by, here and in `packages/agent`. */
export const LIVE_SUITE_TAG = '@live';

/**
 * The name the live suite reports under.
 *
 * The tag rides in the name because that is what `vitest -t` matches on, which
 * is how `live-smoke-path.md` asks for the tier to be selectable and how
 * `packages/agent/src/live-llm.integration.test.ts` already spells it. The skip
 * reason rides there too: the spec's rule is that a missing secret reads as
 * skipped and never as green, and a nameless skip is halfway back to silent.
 */
export function liveSuiteName(skipReason: string | undefined): string {
  const name = `the Solari live smoke ${LIVE_SUITE_TAG}`;
  return skipReason === undefined ? name : `${name} — ${skipReason}`;
}

/**
 * The whole composed vendor path, once - against whatever clients it is handed.
 *
 * Every decision the smoke makes lives here rather than in {@link runLiveSmoke}
 * so that `pnpm check` can reach it. The teardown below is the reason that
 * matters: it was written to fix a defect where a failing body skipped the
 * release entirely, and a proof that only runs when someone is being billed is
 * not a proof that guards the fix.
 *
 * Teardown follows {@link withBrowser}: on the failure path the body's error is
 * what propagates and teardown failures are reported, because the body's error
 * is the one the caller can act on; on the success path a teardown failure is
 * itself the finding, since a held slot or a surviving proxy thread is exactly
 * what this smoke exists to notice.
 */
export async function runLiveSmokeWith(
  dependencies: LiveSmokeDependencies,
  options: LiveSmokeOptions,
): Promise<LiveSmokeReport> {
  const { provider, replayClient, probeBody } = dependencies;
  const url = options.url ?? SMOKE_URL;
  const flushMs = options.flushMs ?? RRWEB_FLUSH_MS;

  const teardowns: readonly Teardown[] = [
    { what: 'provider.dispose()', run: () => provider.dispose() },
    { what: 'solari.close()', run: () => replayClient.close() },
  ];

  let report: LiveSmokeReport;

  try {
    let sessionId: string | undefined;

    // No stealth, no proxy, no captcha: the fast pool. Recording is the one
    // capability this smoke needs, because the replay is half of what it proves.
    const title = await withBrowser(provider, { recording: true }, async (session) => {
      sessionId = session.meta.sessionId;
      const page = await session.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      const pageTitle = await page.title();

      // rrweb batches. Releasing straight after `title()` races the last flush,
      // and the replay that results is missing the very events we navigated for.
      await delay(flushMs);
      return pageTitle;
    });

    if (sessionId === undefined) {
      throw new Error('the session released without ever reporting an id');
    }

    // Read the ledger before dispose, which is what empties it. Asking after
    // teardown would assert on the teardown rather than on the release.
    const liveSessionIdsAfterRelease = [...provider.liveSessionIds()];

    const replay = await pollReplayUrl(replayClient.sessions, sessionId);
    const body = await probeBody(replay.url);

    report = {
      sessionId,
      title,
      replayUrl: replay.url,
      replayAttempts: replay.attempts,
      replayContentEncoding: replay.contentEncoding,
      replayResponseEncoding: body.responseEncoding,
      replayBodyShape: body.shape,
      replayBytes: body.bytes,
      liveSessionIdsAfterRelease,
    };
  } catch (bodyError) {
    const sink = options.onTeardownFailure ?? reportTeardownFailureToConsole;
    for (const failure of await runTeardowns(teardowns)) sink(failure);
    throw bodyError;
  }

  const failures = await runTeardowns(teardowns);
  if (failures.length > 0) {
    throw new Error(
      `the live smoke reached the end of its path but could not tear down: ${failures
        .map((failure) => `${failure.what}: ${describeError(failure.error)}`)
        .join('; ')}`,
    );
  }

  return report;
}

/**
 * The live entry point: builds the two real vendor clients and hands them to
 * {@link runLiveSmokeWith}.
 *
 * Deliberately nothing but construction, so the only part of the live path a
 * credential-free run cannot reach is the wiring itself.
 *
 * Two clients are built, deliberately. The provider gets its own, because that
 * is the object under test. The replay is read through a second, launch-free
 * client because replay is a Solari artifact and not part of the
 * {@link import('./provider.js').BrowserProvider} contract - widening the seam,
 * or the adapter's injected-client surface, for one nightly caller would let a
 * vendor-shaped concern leak into the interface every engine depends on. The
 * second client creates no session and so costs nothing beyond one GET, and it
 * is given the poll's own budget rather than the SDK's 90s default, so a single
 * unanswered call cannot outlive the window {@link pollReplayUrl} advertises.
 */
export async function runLiveSmoke(options: LiveSmokeOptions): Promise<LiveSmokeReport> {
  return runLiveSmokeWith(
    {
      provider: createSolariProvider({ apiKey: options.apiKey }),
      replayClient: createSolariClient({
        apiKey: options.apiKey,
        timeoutMs: REPLAY_POLL_TIMEOUT_MS,
      }),
      probeBody: probeReplayBody,
    },
    options,
  );
}
