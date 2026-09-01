import { afterEach, describe, expect, it } from 'vitest';

import {
  assertNoLeakedFixtures,
  liveFixtureCount,
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

  it('fails the run when an instance is left running', async () => {
    const leaked = await startProbeFixture();

    expect(liveFixtureCount()).toBe(1);
    expect(() => assertNoLeakedFixtures()).toThrow(/probe/);

    await leaked.stop();
  });
});
