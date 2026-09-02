import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';

/**
 * A stand-in for the recording store: one real rrweb recording of a fake gym
 * cancellation, served every way a store has been seen to serve one, plus the
 * two ways a store can let a reader down.
 *
 * The recording itself was made once, by rrweb recording a Chromium page
 * through a cancellation, and committed; it is a fixture, not a mock, so a
 * player that cannot play it cannot play the real thing either.
 */
export interface RecordingServer {
  readonly url: string;
  /** Plain NDJSON, `application/x-ndjson`. */
  readonly plain: string;
  /** Gzipped body with `content-encoding: gzip` - the shape the live store was seen to use. */
  readonly gzip: string;
  /** Gzipped bytes with no encoding header: a store that hands over the file as stored. */
  readonly rawGzip: string;
  /** A body that is not a recording at all. */
  readonly corrupt: string;
  /** A recording the store no longer has. */
  readonly missing: string;
  stop(): Promise<void>;
}

const FIXTURE = new URL('./fake-gym-cancellation.ndjson', import.meta.url);

export async function readFixtureRecording(): Promise<string> {
  return readFile(FIXTURE, 'utf8');
}

export async function startRecordingServer(): Promise<RecordingServer> {
  const recording = await readFixtureRecording();
  const gzipped = gzipSync(recording);
  const server: Server = createServer((request, response) => {
    switch (request.url) {
      case '/plain':
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        response.end(recording);
        return;
      case '/gzip':
        response.writeHead(200, { 'content-type': 'application/x-ndjson', 'content-encoding': 'gzip' });
        response.end(gzipped);
        return;
      case '/raw-gzip':
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(gzipped);
        return;
      case '/corrupt':
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        response.end('this is not a recording\n{"type":');
        return;
      default:
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('no such recording');
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${String(port)}`;
  return {
    url,
    plain: `${url}/plain`,
    gzip: `${url}/gzip`,
    rawGzip: `${url}/raw-gzip`,
    corrupt: `${url}/corrupt`,
    missing: `${url}/missing`,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
