import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  RecordingFetchError,
  RecordingFormatError,
  describeReplayFailure,
  parseRecording,
} from './recording-events';

const FIXTURE = new URL('../testing/fake-gym-cancellation.ndjson', import.meta.url);
const META = '{"type":4,"data":{"href":"https://fake.gym/"},"timestamp":1}';
const SNAPSHOT = '{"type":2,"data":{"node":{}},"timestamp":2}';

describe('parseRecording', () => {
  it('reads the fixture recording: one event per line, in the order captured', async () => {
    const events = parseRecording(await readFile(FIXTURE, 'utf8'));

    expect(events).toHaveLength(12);
    expect(events.slice(0, 2).map((event) => event.type)).toEqual([4, 2]);
    const stamps = events.map((event) => event.timestamp);
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
  });

  it('tolerates Windows line endings and blank lines', () => {
    expect(parseRecording(`${META}\r\n\r\n${SNAPSHOT}\r\n`)).toHaveLength(2);
  });

  it('refuses an empty body', () => {
    expect(() => parseRecording('\n\n')).toThrow(RecordingFormatError);
    expect(() => parseRecording('')).toThrow(/empty/u);
  });

  it('refuses a line that is not JSON, naming the line', () => {
    expect(() => parseRecording(`${META}\nthis is not a recording\n`)).toThrow(/line 2 is not JSON/u);
  });

  it('refuses JSON that is not an event', () => {
    expect(() => parseRecording(`{"hello":"world"}\n${SNAPSHOT}`)).toThrow(/line 1 is not an rrweb event/u);
    expect(() => parseRecording(`${META}\n"a string"`)).toThrow(/line 2 is not an rrweb event/u);
    expect(() => parseRecording(`${META}\n{"type":2,"timestamp":2,"data":null}`)).toThrow(
      /line 2 is not an rrweb event/u,
    );
  });

  it('refuses a recording with nothing to rebuild the page from', () => {
    expect(() => parseRecording(META)).toThrow(/full snapshot/u);
    expect(() => parseRecording(`${META}\n{"type":3,"data":{},"timestamp":3}`)).toThrow(/full snapshot/u);
  });
});

describe('describeReplayFailure', () => {
  it('tells the reader what happened, without a stack', () => {
    expect(describeReplayFailure(new RecordingFetchError(502))).toBe(
      'The recording could not be fetched: the server answered 502.',
    );
    expect(describeReplayFailure(new RecordingFormatError('line 2 is not JSON'))).toBe(
      'The recording could not be played: line 2 is not JSON.',
    );
    expect(describeReplayFailure(new TypeError('Failed to fetch'))).toBe(
      'The recording could not be fetched: the dashboard did not answer.',
    );
    expect(describeReplayFailure(new Error('boom'))).toBe('The recording could not be played.');
    expect(describeReplayFailure('boom')).toBe('The recording could not be played.');
  });
});
