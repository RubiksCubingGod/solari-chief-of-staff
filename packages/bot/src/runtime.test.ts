import { describe, expect, it } from 'vitest';

import { logPollingFailure, logUpdateFailure } from './runtime.js';

/**
 * The two reporters, and only the two reporters. Everything else in
 * `runtime.ts` needs a database and a transport and is proven in
 * `runtime.integration.test.ts`; these two need neither, and they are the last
 * thing between a bot that has gone deaf and nobody finding out, which is
 * reason enough not to leave them to a proof that has to boot Postgres first.
 */

describe('logPollingFailure', () => {
  it('writes the failure somewhere an operator can see it', () => {
    const lines: string[] = [];

    logPollingFailure(new Error("Call to 'getUpdates' failed! (401: Unauthorized)"), (line) =>
      lines.push(line),
    );

    expect(lines).toEqual([
      "[bot] long polling stopped: Call to 'getUpdates' failed! (401: Unauthorized)",
    ]);
  });

  it('defaults to the process error stream', () => {
    expect(writtenToConsole(() => logPollingFailure(new Error('socket hang up')))).toEqual([
      '[bot] long polling stopped: socket hang up',
    ]);
  });

  it('says what it was given when what it was given is not an Error', () => {
    const lines: string[] = [];

    // A rejected promise can carry anything, and the reporter is the last
    // place that can still say something useful about it.
    logPollingFailure('the poll gave up', (line) => lines.push(line));

    expect(lines).toEqual(['[bot] long polling stopped: the poll gave up']);
  });
});

describe('logUpdateFailure', () => {
  it('writes the failure somewhere an operator can see it', () => {
    const lines: string[] = [];

    logUpdateFailure(
      new Error("GrammyError in middleware: Call to 'sendMessage' failed! (403: Forbidden)"),
      (line) => lines.push(line),
    );

    expect(lines).toEqual([
      "[bot] update failed: GrammyError in middleware: Call to 'sendMessage' failed! (403: Forbidden)",
    ]);
  });

  it('defaults to the process error stream', () => {
    expect(writtenToConsole(() => logUpdateFailure(new Error('chat not found')))).toEqual([
      '[bot] update failed: chat not found',
    ]);
  });

  it('says what it was given when what it was given is not an Error', () => {
    const lines: string[] = [];

    logUpdateFailure({ nothing: 'useful' }, (line) => lines.push(line));

    expect(lines).toEqual(['[bot] update failed: [object Object]']);
  });
});

/** What `console.error` received while `run` was running. */
function writtenToConsole(run: () => void): unknown[] {
  const written: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]): void => {
    written.push(args[0]);
  };
  try {
    run();
  } finally {
    console.error = original;
  }
  return written;
}
