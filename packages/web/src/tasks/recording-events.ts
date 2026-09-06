import type { eventWithTime } from '@rrweb/types';

/**
 * A recording is NDJSON: one rrweb event per line, in the order captured.
 * This reads one, and refuses anything that only looks like one.
 *
 * It runs on the browser side of the dashboard, next to the player, so a
 * refusal has to be a state a page can show rather than a stack: "could not
 * be played", with the reason, beside a timeline that still renders. By the
 * time text reaches here the API has settled who may read it and undone
 * whatever the store did to the bytes (the live store was seen serving gzip
 * both declared and undeclared; `recording.ts` in the API sniffs for it), so
 * what is left to go wrong is the content.
 */

export class RecordingFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordingFormatError';
  }
}

/** The dashboard's own route answered with a status instead of a recording. */
export class RecordingFetchError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`the recording could not be fetched: the server answered ${String(status)}`);
    this.name = 'RecordingFetchError';
    this.status = status;
  }
}

/** rrweb's event type for a full DOM snapshot, without which nothing can be rebuilt. */
const FULL_SNAPSHOT = 2;

export function parseRecording(text: string): eventWithTime[] {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) throw new RecordingFormatError('the recording is empty');

  const events = lines.map((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new RecordingFormatError(`line ${String(index + 1)} is not JSON`);
    }
    if (!isEvent(parsed)) {
      throw new RecordingFormatError(`line ${String(index + 1)} is not an rrweb event`);
    }
    return parsed;
  });

  if (events.length < 2 || !events.some(isFullSnapshot)) {
    throw new RecordingFormatError('the recording has no full snapshot to rebuild the page from');
  }
  return events;
}

/** rrweb types `type` as its own enum; the wire carries the number. */
function isFullSnapshot(event: eventWithTime): boolean {
  return Number(event.type) === FULL_SNAPSHOT;
}

function isEvent(value: unknown): value is eventWithTime {
  if (typeof value !== 'object' || value === null) return false;
  const { type, timestamp, data } = value as {
    type?: unknown;
    timestamp?: unknown;
    data?: unknown;
  };
  return (
    typeof type === 'number' &&
    typeof timestamp === 'number' &&
    typeof data === 'object' &&
    data !== null
  );
}

/** The sentence the reader gets, for everything that can go wrong before a frame is drawn. */
export function describeReplayFailure(error: unknown): string {
  if (error instanceof RecordingFetchError) {
    return `The recording could not be fetched: the server answered ${String(error.status)}.`;
  }
  if (error instanceof RecordingFormatError) {
    return `The recording could not be played: ${error.message}.`;
  }
  // `fetch` reports a network failure as a TypeError and nothing more specific.
  if (error instanceof TypeError) {
    return 'The recording could not be fetched: the dashboard did not answer.';
  }
  return 'The recording could not be played.';
}
