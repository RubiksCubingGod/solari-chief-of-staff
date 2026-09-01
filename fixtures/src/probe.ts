import type { Express } from 'express';

import {
  type ControlRequest,
  type FixtureHandle,
  startFixture,
  type StartFixtureOptions,
} from './harness.js';

/**
 * The smallest possible fixture. It exists only to prove the harness seam -
 * boot, isolation, teardown, port release, stopped-instance refusal - without
 * entangling those proofs with any real site's behavior. Nothing outside the
 * harness's own tests should use it.
 */
export interface ProbeControl {
  value(): Promise<string>;
  setValue(next: string): Promise<void>;
}

const SEEDED_VALUE = 'seeded';

export function startProbeFixture(
  options: StartFixtureOptions = {},
): Promise<FixtureHandle<ProbeControl>> {
  let value = SEEDED_VALUE;

  const mount = (app: Express): void => {
    app.get('/probe', (_request, response) => {
      response.type('text/plain').send('probe');
    });
    app.get('/__test/state', (_request, response) => {
      response.json({ value });
    });
    app.post('/__test/state', (request, response) => {
      const body: unknown = request.body;
      if (typeof body !== 'object' || body === null || typeof Reflect.get(body, 'value') !== 'string') {
        response.status(400).json({ error: 'value must be a string' });
        return;
      }
      value = Reflect.get(body, 'value') as string;
      response.json({ value });
    });
  };

  const buildControl = (request: ControlRequest): ProbeControl => ({
    value: async () => (await request<{ value: string }>('GET', '/__test/state')).value,
    setValue: async (next) => {
      await request('POST', '/__test/state', { value: next });
    },
  });

  return startFixture('probe', mount, buildControl, options);
}
