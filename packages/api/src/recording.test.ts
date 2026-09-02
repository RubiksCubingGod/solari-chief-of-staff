import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  RecordingUnavailableError,
  fetchRecording,
  isGzip,
  readRecording,
} from './recording.js';

const RECORDING = '{"type":4,"data":{},"timestamp":1}\n{"type":2,"data":{},"timestamp":2}\n';
const encoder = new TextEncoder();

function answering(status: number, body: Uint8Array | string): (url: string) => Promise<Response> {
  return () => Promise.resolve(new Response(body, { status }));
}

describe('isGzip', () => {
  it('recognises a gzip member by its first two bytes and nothing else', () => {
    expect(isGzip(gzipSync(RECORDING))).toBe(true);
    expect(isGzip(encoder.encode(RECORDING))).toBe(false);
    expect(isGzip(new Uint8Array([0x1f]))).toBe(false);
    expect(isGzip(new Uint8Array())).toBe(false);
  });
});

describe('readRecording', () => {
  it('inflates a gzipped body and passes a plain one through, to the same text', () => {
    expect(readRecording(new Uint8Array(gzipSync(RECORDING)))).toBe(RECORDING);
    expect(readRecording(encoder.encode(RECORDING))).toBe(RECORDING);
  });

  it('refuses a gzip body that does not inflate, naming the store rather than the bytes', () => {
    const truncated = new Uint8Array(gzipSync(RECORDING)).slice(0, 12);
    expect(() => readRecording(truncated)).toThrow(RecordingUnavailableError);
    expect(() => readRecording(truncated)).toThrow(/does not inflate/u);
  });

  it('refuses a body that is not text', () => {
    expect(() => readRecording(new Uint8Array([0xff, 0xfe, 0xfd]))).toThrow(/not UTF-8/u);
  });
});

describe('fetchRecording', () => {
  it('asks the store once and hands back its recording as text', async () => {
    const asked: string[] = [];
    const send = (url: string): Promise<Response> => {
      asked.push(url);
      return Promise.resolve(new Response(gzipSync(RECORDING), { status: 200 }));
    };

    await expect(fetchRecording('https://store.test/one', send)).resolves.toBe(RECORDING);
    expect(asked).toEqual(['https://store.test/one']);
  });

  it('reports a store that refuses as unavailable, with the status it gave', async () => {
    await expect(fetchRecording('https://store.test/gone', answering(404, 'gone'))).rejects.toThrow(
      /answered 404/u,
    );
  });

  it('reports a store that does not answer as unavailable, keeping the cause', async () => {
    const refused = new Error('ECONNREFUSED');
    const send = (): Promise<Response> => Promise.reject(refused);

    const failure = await fetchRecording('https://store.test/dead', send).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RecordingUnavailableError);
    expect((failure as RecordingUnavailableError).cause).toBe(refused);
    expect((failure as Error).message).not.toContain('store.test');
  });
});
