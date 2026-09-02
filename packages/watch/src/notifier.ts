import type { NotifierPort, WatchEvent } from '@chief-of-staff/core';

/** Where a line goes. The default is the process's stdout, next to the harness's own lines. */
export type LogSink = (line: string) => void;

/**
 * The notifier a deployment runs until a delivery channel lands: every event
 * is one JSON line, whole, with its dedup key, so a trigger is never silently
 * lost - it is in the process log - and the port is proven end to end without
 * a bot behind it. Writing a line cannot fail, so a check that reaches this
 * notifier always completes; the delivery-failure path is the recording
 * notifier's to prove.
 */
export function createLogNotifier(
  write: LogSink = (line) => {
    process.stdout.write(`${line}\n`);
  },
): NotifierPort {
  return {
    notify(event: WatchEvent) {
      write(JSON.stringify(event));
      return Promise.resolve();
    },
  };
}
