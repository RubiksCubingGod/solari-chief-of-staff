import { afterEach, describe, expect, it } from 'vitest';

import {
  assertNoLeakedFixtures,
  type FixtureHandle,
  liveFixtureCount,
  type ProbeControl,
  startProbeFixture,
} from './index.js';

afterEach(() => {
  // Every test here is responsible for its own teardown; this catches a test
  // that forgot, so one leak cannot cascade into the next assertion.
  assertNoLeakedFixtures();
});

describe('fixture harness', () => {
  it('boots a private instance, serves it, and stops it', async () => {
    const fixture = await startProbeFixture();

    const response = await fetch(`${fixture.url}/probe`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('probe');

    await fixture.stop();
  });

  it('gives concurrent instances of one kind independent state', async () => {
    const [first, second] = await Promise.all([startProbeFixture(), startProbeFixture()]);

    expect(first.url).not.toBe(second.url);
    await first.control.setValue('changed');

    expect(await first.control.value()).toBe('changed');
    expect(await second.control.value()).toBe('seeded');

    await Promise.all([first.stop(), second.stop()]);
  });

  it('releases the port on stop', async () => {
    const fixture = await startProbeFixture();
    const port = Number(new URL(fixture.url).port);
    await fixture.stop();

    // Proven by rebinding rather than by trusting the close callback.
    const rebound = await startProbeFixture({ port });
    expect(Number(new URL(rebound.url).port)).toBe(port);

    await rebound.stop();
  });

  it('is idempotent on repeated stop', async () => {
    const fixture = await startProbeFixture();

    await fixture.stop();
    await expect(fixture.stop()).resolves.toBeUndefined();
  });

  it('refuses a control-plane call against a stopped instance', async () => {
    const fixture = await startProbeFixture();
    await fixture.stop();

    await expect(fixture.control.value()).rejects.toThrow(/stopped/i);
  });

  it('registers nothing when a start fails, and tolerates teardown afterwards', async () => {
    const holder = await startProbeFixture();
    const port = Number(new URL(holder.url).port);

    // Colliding on a bound port is the cheapest real start failure.
    let failed: FixtureHandle<ProbeControl> | undefined;
    await expect(
      startProbeFixture({ port }).then((handle) => {
        failed = handle;
        return handle;
      }),
    ).rejects.toThrow(/EADDRINUSE/);

    // The substantive claim: a start that threw left no registration behind, so
    // it cannot make an unrelated later test fail the leak assert. Only the
    // instance this test deliberately holds is live.
    expect(liveFixtureCount()).toBe(1);

    // And the teardown a caller would actually write after a failed start -
    // there is no handle to stop - resolves rather than throwing.
    await expect(Promise.resolve(failed?.stop())).resolves.toBeUndefined();

    await holder.stop();
    expect(liveFixtureCount()).toBe(0);
  });

  it('fails the run when an instance is left running', async () => {
    const leaked = await startProbeFixture();

    expect(liveFixtureCount()).toBe(1);
    expect(() => assertNoLeakedFixtures()).toThrow(/probe/);

    await leaked.stop();
  });
});
