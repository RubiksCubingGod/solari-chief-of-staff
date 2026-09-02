import { gunzipSync } from 'node:zlib';

/**
 * Reading a recording out of whatever the store handed back.
 *
 * The live store was seen serving a recording gzipped with the encoding
 * declared, which a fetch that honours the header inflates on the way in, and
 * handing the same bytes over as stored to a client that does not. So the
 * bytes that arrive here may or may not be gzip, whatever the headers claim,
 * and it is the bytes that are asked: a gzip member starts `1f 8b`, and
 * nothing that is NDJSON does.
 */

export const NDJSON_CONTENT_TYPE = 'application/x-ndjson; charset=utf-8';

/** How long the store gets before its silence is reported as an answer. */
export const RECORDING_FETCH_TIMEOUT_MS = 15_000;

/**
 * The store refused, did not answer, or answered with something that is not a
 * recording. It carries no address: a recording URL may be presigned, and the
 * credential in it is not for a log line or an error envelope.
 */
export class RecordingUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RecordingUnavailableError';
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** The recording as NDJSON text, inflated first if it arrived gzipped. */
export function readRecording(bytes: Uint8Array): string {
  let plain: Uint8Array;
  try {
    plain = isGzip(bytes) ? new Uint8Array(gunzipSync(bytes)) : bytes;
  } catch (cause) {
    throw new RecordingUnavailableError('the recording store sent a gzip body that does not inflate', { cause });
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(plain);
  } catch (cause) {
    throw new RecordingUnavailableError('the recording store sent a body that is not UTF-8 text', { cause });
  }
}

/** Fetches a recording from its store and hands it over as NDJSON text. */
export async function fetchRecording(url: string, send: FetchLike = fetch): Promise<string> {
  let response: Response;
  try {
    response = await send(url, {
      headers: { accept: 'application/x-ndjson, application/octet-stream;q=0.9, */*;q=0.8' },
      signal: AbortSignal.timeout(RECORDING_FETCH_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new RecordingUnavailableError('the recording store did not answer', { cause });
  }
  if (!response.ok) {
    throw new RecordingUnavailableError(
      `the recording store answered ${String(response.status)} instead of the recording`,
    );
  }
  return readRecording(new Uint8Array(await response.arrayBuffer()));
}
