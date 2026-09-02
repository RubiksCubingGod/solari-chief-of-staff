import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createJobHarness, logHarnessError, runWorker, type JobHarness } from './jobs.js';
import { startTestPostgres, type TestPostgres } from './testing/postgres.js';

let postgres: TestPostgres;
const started: JobHarness[] = [];

beforeAll(async () => {
  postgres = await startTestPostgres();
});

afterEach(async () => {
  for (const harness of started.splice(0)) await harness.stop();
});

afterAll(async () => {
  await postgres.stop();
});

function build(options: Partial<Parameters<typeof createJobHarness>[0]> = {}): JobHarness {
  const harness = createJobHarness({
    connectionString: postgres.connectionString,
    pollingIntervalSeconds: 0.5,
    ...options,
  });
  started.push(harness);
  return harness;
}

async function harness(options?: Partial<Parameters<typeof createJobHarness>[0]>): Promise<JobHarness> {
  const instance = build(options);
  await instance.start();
  return instance;
}

/** A fresh queue per test, so one test's leftovers cannot satisfy another's wait. */
function queueName(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

describe('the pg-boss job harness', () => {
  it('round-trips a queued job and reports it completed', async () => {
    const instance = await harness();
    const queue = queueName('round-trip');
    const seen: string[] = [];
    await instance.register<{ url: string }>(queue, (payload) => {
      seen.push(payload.url);
      return Promise.resolve();
    });

    const id = await instance.enqueue(queue, { url: 'https://example.test/a' });
    await vi.waitFor(async () => {
      expect((await instance.inspect(queue, id))?.state).toBe('completed');
    }, { timeout: 20_000, interval: 100 });

    expect(seen).toEqual(['https://example.test/a']);
  });

  it('retries a failing handler to the limit, then leaves it observably failed', async () => {
    const instance = await harness({ retryPolicy: { retryLimit: 2, retryDelaySeconds: 0 } });
    const queue = queueName('flaky');
    let attempts = 0;
    await instance.register(queue, () => {
      attempts += 1;
      return Promise.reject(new Error('the site refused the request'));
    });

    const id = await instance.enqueue(queue, {});
    await vi.waitFor(async () => {
      expect((await instance.inspect(queue, id))?.state).toBe('failed');
    }, { timeout: 30_000, interval: 200 });

    const record = await instance.inspect(queue, id);
    expect(attempts).toBe(3);
    expect(record?.attempts).toBe(2);
    expect(JSON.stringify(record?.output)).toContain('the site refused the request');
  });

  it('runs a job that was enqueued before any worker existed', async () => {
    const queue = queueName('durable');
    const producer = await harness();
    const id = await producer.enqueue(queue, { n: 1 });
    await producer.stop();
    started.splice(started.indexOf(producer), 1);

    const worker = await harness();
    const seen: { n: number }[] = [];
    await worker.register<{ n: number }>(queue, (payload) => {
      seen.push(payload);
      return Promise.resolve();
    });

    await vi.waitFor(async () => {
      expect((await worker.inspect(queue, id))?.state).toBe('completed');
    }, { timeout: 20_000, interval: 100 });
    expect(seen).toEqual([{ n: 1 }]);
  });

  it('has nothing to report about a job id it has never seen', async () => {
    const instance = await harness();
    const queue = queueName('unknown');
    await instance.enqueue(queue, {});

    expect(await instance.inspect(queue, randomUUID())).toBeNull();
  });

  it(
    'fires a registered cron schedule',
    async () => {
      const instance = await harness({ cronIntervalSeconds: 1 });
      const queue = queueName('ticks');
      let fired = 0;
      await instance.register(queue, () => {
        fired += 1;
        return Promise.resolve();
      });

      await instance.schedule(queue, '* * * * *');

      await vi.waitFor(() => {
        expect(fired).toBeGreaterThan(0);
      }, { timeout: 110_000, interval: 500 });
    },
    120_000,
  );
});

/**
 * One queue, many schedules: a watch engine has a cron per watch, and pausing
 * one watch must not touch the others'. The key is what tells them apart.
 */
describe('keyed schedules', () => {
  it('keeps one schedule per key, replaces by key, and removes one without touching the rest', async () => {
    const instance = await harness();
    const queue = queueName('keyed');
    const byKey = async () =>
      (await instance.schedules(queue)).sort((left, right) => left.key.localeCompare(right.key));

    await instance.schedule(queue, '*/15 * * * *', { watchId: 'a' }, { key: 'a' });
    await instance.schedule(queue, '*/30 * * * *', { watchId: 'b' }, { key: 'b' });
    await instance.schedule(queue, '0 * * * *');

    expect(await byKey()).toEqual([
      { queue, key: '', cron: '0 * * * *', payload: {} },
      { queue, key: 'a', cron: '*/15 * * * *', payload: { watchId: 'a' } },
      { queue, key: 'b', cron: '*/30 * * * *', payload: { watchId: 'b' } },
    ]);

    await instance.schedule(queue, '*/20 * * * *', { watchId: 'a' }, { key: 'a' });
    expect((await byKey()).map((record) => record.cron)).toEqual(['0 * * * *', '*/20 * * * *', '*/30 * * * *']);

    await instance.unschedule(queue, 'a');
    expect((await byKey()).map((record) => record.key)).toEqual(['', 'b']);

    await instance.unschedule(queue);
    expect((await byKey()).map((record) => record.key)).toEqual(['b']);

    // Removing what is not there is not an error.
    await expect(instance.unschedule(queue, 'a')).resolves.toBeUndefined();
  });

  it('has nothing to report for a queue nobody has scheduled', async () => {
    const instance = await harness();
    expect(await instance.schedules(queueName('unscheduled'))).toEqual([]);
  });
});

/**
 * A watch check that is halfway through a browser session must not be failed
 * just because the worker is being replaced: pg-boss hands a failed-in-flight
 * job to the next process, which runs the same side effect a second time.
 * Shutdown therefore drains what is already running, and only a caller that
 * explicitly asks for the fast path gives that up.
 */
describe('shutting the harness down', () => {
  /** Long enough that the handler is unambiguously mid-flight when stop() lands. */
  const HANDLER_MILLISECONDS = 3_000;

  /** No retries, so a job failed at shutdown lands in `failed` rather than `retry`. */
  const NO_RETRIES = { retryLimit: 0, retryDelaySeconds: 0 };

  async function runningHandler(
    queue: string,
    state: { entered: boolean; returned: boolean },
    options: Partial<Parameters<typeof createJobHarness>[0]> = {},
  ): Promise<{ worker: JobHarness; id: string }> {
    const worker = await harness({ retryPolicy: NO_RETRIES, ...options });
    await worker.register(queue, async () => {
      state.entered = true;
      await new Promise((resolve) => setTimeout(resolve, HANDLER_MILLISECONDS));
      state.returned = true;
    });

    const id = await worker.enqueue(queue, {});
    await vi.waitFor(
      () => {
        expect(state.entered).toBe(true);
      },
      { timeout: 20_000, interval: 50 },
    );

    started.splice(started.indexOf(worker), 1);
    return { worker, id };
  }

  it(
    'waits for a handler that is already running, so its job completes',
    async () => {
      const queue = queueName('draining');
      const state = { entered: false, returned: false };
      const { worker, id } = await runningHandler(queue, state);

      await worker.stop();

      expect(state.returned).toBe(true);

      const observer = await harness();
      expect((await observer.inspect(queue, id))?.state).toBe('completed');
    },
    60_000,
  );

  it(
    'abandons the drain only when the caller asks for the fast path',
    async () => {
      const queue = queueName('abandoned');
      const state = { entered: false, returned: false };
      const { worker, id } = await runningHandler(queue, state);

      await worker.stop({ graceful: false });

      expect(state.returned).toBe(false);

      const observer = await harness();
      expect((await observer.inspect(queue, id))?.state).toBe('failed');
    },
    60_000,
  );

  it(
    'stops waiting once the shutdown window is spent',
    async () => {
      const queue = queueName('wedged');
      const state = { entered: false, returned: false };
      // pg-boss floors the window at one second, and the handler outlasts it.
      const { worker, id } = await runningHandler(queue, state, { shutdownTimeoutSeconds: 1 });

      const startedAt = Date.now();
      await worker.stop();
      const elapsed = Date.now() - startedAt;

      expect(state.returned).toBe(false);
      expect(elapsed).toBeLessThan(HANDLER_MILLISECONDS);

      const observer = await harness();
      expect((await observer.inspect(queue, id))?.state).toBe('failed');
    },
    60_000,
  );
});

describe('runWorker', () => {
  it('starts the harness, applies every registration, and hands back a shutdown', async () => {
    const instance = build();
    const queue = queueName('worker');
    const seen: unknown[] = [];

    const stop = await runWorker(instance, [
      (target) =>
        target.register(queue, (payload) => {
          seen.push(payload);
          return Promise.resolve();
        }),
    ]);

    const id = await instance.enqueue(queue, { ok: true });
    await vi.waitFor(async () => {
      expect((await instance.inspect(queue, id))?.state).toBe('completed');
    }, { timeout: 20_000, interval: 100 });
    expect(seen).toEqual([{ ok: true }]);

    await stop();
    started.splice(started.indexOf(instance), 1);
  });
});

describe('logHarnessError', () => {
  it('writes the failure somewhere an operator can see it', () => {
    const lines: string[] = [];

    logHarnessError(new Error('connection terminated'), (line) => lines.push(line));

    expect(lines).toEqual(['[jobs] pg-boss reported an error: connection terminated']);
  });

  it('defaults to the process error stream', () => {
    const write = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    logHarnessError(new Error('boom'));

    expect(write).toHaveBeenCalledWith('[jobs] pg-boss reported an error: boom');
    write.mockRestore();
  });
});
