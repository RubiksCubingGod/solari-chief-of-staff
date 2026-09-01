import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import {
  API_KEY_VARIABLE,
  LIVE_SMOKE_FLAG,
  liveSmokeSkipReason,
  pollReplayUrl,
  probeReplayBody,
  type ReplayReader,
} from './live-smoke.js';

/**
 * The guard, tested without a network.
 *
 * This is the whole reason `liveSmokeSkipReason` takes an env record instead of
 * reading `process.env`: the decision that governs whether we spend money is a
 * pure function, so it can be pinned down exhaustively here rather than being
 * discovered on a billing statement.
 */

describe('liveSmokeSkipReason', () => {
  it('skips when the opt-in flag is absent, even with a valid key', () => {
    const reason = liveSmokeSkipReason({ [API_KEY_VARIABLE]: 'sk-live-real' });

    // The expensive default. A key on the machine is not consent to spend it.
    expect(reason).toBeDefined();
    expect(reason).toContain(LIVE_SMOKE_FLAG);
  });

  it('skips when the flag is set but no key is configured', () => {
    const reason = liveSmokeSkipReason({ [LIVE_SMOKE_FLAG]: '1' });

    // Names the missing variable, because this reason is printed by CI and by
    // the runner script and has to tell a human what to fix.
    expect(reason).toBeDefined();
    expect(reason).toContain(API_KEY_VARIABLE);
  });

  it('treats an empty key as absent', () => {
    // An unset Actions secret interpolates to the empty string rather than
    // vanishing, so this is the shape CI actually produces on a fork PR.
    const reason = liveSmokeSkipReason({ [LIVE_SMOKE_FLAG]: '1', [API_KEY_VARIABLE]: '' });

    expect(reason).toContain(API_KEY_VARIABLE);
  });

  it('treats a whitespace-only key as absent', () => {
    const reason = liveSmokeSkipReason({ [LIVE_SMOKE_FLAG]: '1', [API_KEY_VARIABLE]: '   ' });

    expect(reason).toContain(API_KEY_VARIABLE);
  });

  it('treats an empty flag as not opted in', () => {
    const reason = liveSmokeSkipReason({ [LIVE_SMOKE_FLAG]: '', [API_KEY_VARIABLE]: 'sk-live-real' });

    expect(reason).toContain(LIVE_SMOKE_FLAG);
  });

  it('does not opt in on a falsey-looking flag value', () => {
    // `SOLARI_LIVE_SMOKE=0` reads as "no" to every human who writes it. Honoring
    // the string's truthiness instead of its meaning would bill them for it.
    const reason = liveSmokeSkipReason({ [LIVE_SMOKE_FLAG]: '0', [API_KEY_VARIABLE]: 'sk-live-real' });

    expect(reason).toContain(LIVE_SMOKE_FLAG);
  });

  it('returns undefined when the flag is opted in and a key is present', () => {
    const reason = liveSmokeSkipReason({ [LIVE_SMOKE_FLAG]: '1', [API_KEY_VARIABLE]: 'sk-live-real' });

    expect(reason).toBeUndefined();
  });

  it('accepts the other conventional opt-in spellings', () => {
    for (const value of ['true', 'TRUE', 'yes', 'on']) {
      expect(liveSmokeSkipReason({ [LIVE_SMOKE_FLAG]: value, [API_KEY_VARIABLE]: 'sk' })).toBeUndefined();
    }
  });

  it('reports the flag first when both are missing', () => {
    // Order matters for the message a human reads: the flag is the thing they
    // are meant to set deliberately, the key is infrastructure.
    const reason = liveSmokeSkipReason({});

    expect(reason).toContain(LIVE_SMOKE_FLAG);
  });
});

/** A 404 from the gateway: the replay is not written yet, not "never will be". */
function notReadyYet(): Error {
  return Object.assign(new Error('replay not found'), { status: 404 });
}

function readerYielding(errors: Error[]): ReplayReader {
  let call = 0;
  return {
    getReplayUrl: (id) => {
      const error = errors[call];
      call += 1;
      if (error !== undefined) return Promise.reject(error);
      return Promise.resolve({ url: `https://replays.example/${id}`, contentEncoding: 'gzip' });
    },
  };
}

describe('pollReplayUrl', () => {
  const fast = { timeoutMs: 200, intervalMs: 1 };

  it('returns the location on the first call when the replay is already there', async () => {
    const replay = await pollReplayUrl(readerYielding([]), 'session-a', fast);

    expect(replay.url).toBe('https://replays.example/session-a');
    expect(replay.contentEncoding).toBe('gzip');
    expect(replay.attempts).toBe(1);
  });

  it('polls through the 404 window and reports how many attempts it took', async () => {
    // A live run needed four. The window is measured, not padding.
    const replay = await pollReplayUrl(
      readerYielding([notReadyYet(), notReadyYet(), notReadyYet()]),
      'session-b',
      fast,
    );

    expect(replay.attempts).toBe(4);
  });

  it('rethrows anything that is not a 404 without burning the window', async () => {
    // An expired key or a rejected session id is a standing condition. Spending
    // thirty seconds rediscovering it would bury the real error under a timeout.
    const denied = Object.assign(new Error('forbidden'), { status: 403 });

    await expect(
      pollReplayUrl(readerYielding([denied]), 'session-c', { timeoutMs: 30_000, intervalMs: 1 }),
    ).rejects.toThrow('forbidden');
  });

  it('gives up with the attempt count and the last error when the replay never lands', async () => {
    const always = Array.from({ length: 500 }, notReadyYet);

    await expect(pollReplayUrl(readerYielding(always), 'session-d', fast)).rejects.toThrow(
      /session-d was still absent after \d+ attempts over 200ms: replay not found/u,
    );
  });
});

interface ReplayHost {
  readonly url: string;
  readonly close: () => Promise<void>;
}

async function startReplayHost(
  handle: (request: { url: string | undefined }, respond: {
    send: (status: number, headers: Record<string, string>, body: Uint8Array) => void;
  }) => void,
): Promise<ReplayHost> {
  const server: Server = createServer((request, response) => {
    handle(
      { url: request.url },
      {
        send: (status, headers, body) => {
          response.writeHead(status, headers);
          response.end(body);
        },
      },
    );
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(port)}/replay`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let host: ReplayHost | undefined;

afterEach(async () => {
  await host?.close();
  host = undefined;
});

const NDJSON = '{"type":2}\n{"type":3}\n';

describe('probeReplayBody', () => {
  it('reports ndjson when the response declares gzip and undici inflates it', async () => {
    // The observed live shape. The object really is stored gzipped and the
    // presigned response really does say so - which is exactly why what arrives
    // is already text, and why a parser must not gunzip it.
    host = await startReplayHost((_request, respond) => {
      respond.send(200, { 'content-encoding': 'gzip', 'content-type': 'application/x-ndjson' },
        gzipSync(Buffer.from(NDJSON, 'utf8')));
    });

    const body = await probeReplayBody(host.url);

    expect(body.responseEncoding).toBe('gzip');
    expect(body.shape).toBe('ndjson');
    expect(body.bytes).toBe(Buffer.byteLength(NDJSON, 'utf8'));
  });

  it('reports gzip when the bytes arrive undeclared and nothing inflates them', async () => {
    // The other half of the fork, and the reason the shape is reported rather
    // than assumed: drop the header and the identical bytes reach the caller
    // still compressed.
    host = await startReplayHost((_request, respond) => {
      respond.send(200, { 'content-type': 'application/octet-stream' },
        gzipSync(Buffer.from(NDJSON, 'utf8')));
    });

    const body = await probeReplayBody(host.url);

    expect(body.responseEncoding).toBeUndefined();
    expect(body.shape).toBe('gzip');
  });

  it('refuses a presigned URL that answers with an error', async () => {
    // A presigned URL that has expired answers 403 with a body. Sniffing that
    // body would report `ndjson` for an error document.
    host = await startReplayHost((_request, respond) => {
      respond.send(403, { 'content-type': 'application/xml' },
        Buffer.from('<Error>expired</Error>', 'utf8'));
    });

    await expect(probeReplayBody(host.url)).rejects.toThrow('answered 403');
  });
});
