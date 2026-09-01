import {
  createJobHarness,
  runWorker,
  type JobHarness,
  type JobHarnessOptions,
  type JobRegistration,
} from './jobs.js';

export interface WorkerProcess {
  /** Exposed so the process can enqueue and inspect without a second handle. */
  readonly harness: JobHarness;
  stop(): Promise<void>;
}

/**
 * The worker process. Engines contribute registration closures rather than
 * talking to pg-boss directly, so this stays the one place to look for what a
 * deployment runs in the background - and it starts with none of them, because
 * the process exists before the first engine does.
 */
export async function startWorker(
  options: JobHarnessOptions,
  registrations: readonly JobRegistration[] = [],
): Promise<WorkerProcess> {
  const harness = createJobHarness(options);
  const stop = await runWorker(harness, registrations);
  return { harness, stop };
}
