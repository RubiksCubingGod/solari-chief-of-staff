import { PgBoss } from 'pg-boss';

export interface RetryPolicy {
  readonly retryLimit: number;
  readonly retryDelaySeconds: number;
}

/**
 * Three retries, five seconds apart. A watch check or a booking step usually
 * fails because a site was slow or briefly hostile, which a short retry fixes;
 * anything still failing after that is a real fault and belongs in the failed
 * state where it can be seen, not in an infinite retry loop.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = { retryLimit: 3, retryDelaySeconds: 5 };

export interface JobHarnessOptions {
  readonly connectionString: string;
  readonly schema?: string;
  readonly retryPolicy?: RetryPolicy;
  readonly pollingIntervalSeconds?: number;
  readonly cronIntervalSeconds?: number;
  readonly onError?: (error: Error) => void;
}

/** Handlers take one job at a time; batching stays an implementation detail. */
export type JobHandler<TPayload> = (payload: TPayload, jobId: string) => Promise<void>;

export interface JobRecord {
  readonly id: string;
  readonly state: string;
  readonly attempts: number;
  readonly output: unknown;
}

export interface JobHarness {
  start(): Promise<void>;
  register<TPayload>(queue: string, handler: JobHandler<TPayload>): Promise<void>;
  enqueue(queue: string, payload: object): Promise<string>;
  schedule(queue: string, cron: string, payload?: object): Promise<void>;
  inspect(queue: string, jobId: string): Promise<JobRecord | null>;
  stop(): Promise<void>;
}

export type JobRegistration = (harness: JobHarness) => Promise<void>;

/**
 * pg-boss reports background failures — a dropped connection, a maintenance
 * query that could not run — on an `error` event rather than by rejecting a
 * call. An EventEmitter with no `error` listener terminates the process, so the
 * harness always attaches one.
 */
export function logHarnessError(
  error: Error,
  write: (line: string) => void = (line) => {
    console.error(line);
  },
): void {
  write(`[jobs] pg-boss reported an error: ${error.message}`);
}

export function createJobHarness(options: JobHarnessOptions): JobHarness {
  const retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
  const pollingIntervalSeconds = options.pollingIntervalSeconds ?? 2;
  const boss = new PgBoss({
    connectionString: options.connectionString,
    schema: options.schema ?? 'pgboss',
    schedule: true,
    // pg-boss caps both at 45s. Ten seconds means a due cron dispatches within
    // ten seconds of its minute and a schedule change is noticed about as fast,
    // for two cheap queries on that interval.
    cronWorkerIntervalSeconds: options.cronIntervalSeconds ?? 10,
    cronMonitorIntervalSeconds: options.cronIntervalSeconds ?? 10,
  });
  boss.on('error', options.onError ?? logHarnessError);

  const known = new Set<string>();

  async function ensureQueue(queue: string): Promise<void> {
    if (known.has(queue)) return;
    if ((await boss.getQueue(queue)) === null) {
      // Retry policy is a queue property in pg-boss 12, not a client one, so
      // every job in the queue inherits it however it was enqueued.
      await boss.createQueue(queue, {
        retryLimit: retryPolicy.retryLimit,
        retryDelay: retryPolicy.retryDelaySeconds,
      });
    }
    known.add(queue);
  }

  return {
    async start(): Promise<void> {
      await boss.start();
    },

    async register<TPayload>(queue: string, handler: JobHandler<TPayload>): Promise<void> {
      await ensureQueue(queue);
      // One job per fetch, so a throwing handler fails exactly the job that
      // caused it rather than a whole batch of unrelated work.
      await boss.work<TPayload>(queue, { batchSize: 1, pollingIntervalSeconds }, async (jobs) => {
        for (const job of jobs) await handler(job.data, job.id);
      });
    },

    async enqueue(queue: string, payload: object): Promise<string> {
      await ensureQueue(queue);
      const id = await boss.send(queue, payload);
      if (id === null) {
        // Only a queue policy that refuses duplicates returns no id, and these
        // queues are all standard, so this means the queue was dropped between
        // the check above and the insert.
        throw new Error(`Queue '${queue}' refused the job; it may no longer exist.`);
      }
      return id;
    },

    async schedule(queue: string, cron: string, payload?: object): Promise<void> {
      await ensureQueue(queue);
      await boss.schedule(queue, cron, payload ?? {});
    },

    async inspect(queue: string, jobId: string): Promise<JobRecord | null> {
      const job = await boss.getJobById(queue, jobId);
      return job === null
        ? null
        : { id: job.id, state: job.state, attempts: job.retryCount, output: job.output };
    },

    async stop(): Promise<void> {
      await boss.stop({ close: true, graceful: false });
    },
  };
}

/**
 * The worker process entry point. Every consumer contributes a registration
 * closure rather than talking to pg-boss directly, so the process that runs
 * them stays one place to look for what is scheduled.
 */
export async function runWorker(
  harness: JobHarness,
  registrations: readonly JobRegistration[],
): Promise<() => Promise<void>> {
  await harness.start();
  for (const register of registrations) await register(harness);
  return () => harness.stop();
}
