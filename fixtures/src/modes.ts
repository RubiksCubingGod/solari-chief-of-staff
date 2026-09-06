import type { Express, Request, Response } from 'express';

import { type ControlRequest, readRecord } from './harness.js';
import {
  blockedShellPage,
  documentShell,
  type Layout,
  NORMAL_STATE,
  type PageContent,
} from './pages.js';

export type FixtureMode = 'normal' | 'blocked' | 'hard-blocked' | 'redesign';

export const FIXTURE_MODES: readonly FixtureMode[] = [
  'normal',
  'blocked',
  'hard-blocked',
  'redesign',
];

/**
 * The tier-2 escalation marker.
 *
 * It is supplied by the *caller's* fetch configuration, never by the browser
 * provider. `browser-substrate` commits LocalProvider - the only provider that
 * can reach a loopback fixture at all - to echoing stealth as not applied, so a
 * mode gated on the provider's own echo would be unreachable in CI forever.
 * Gating on a caller-supplied header proves the same thing (the engine reached
 * its tier-2 branch, because only that branch sends the header) and keeps
 * `packages/solari` ignorant of fixtures.
 */
export const ESCALATION_HEADER = 'x-fixture-escalation';
export const DEFAULT_ESCALATION_TOKEN = 'fixture-escalation-token';

export interface ModeControl {
  setMode(mode: FixtureMode): Promise<void>;
  mode(): Promise<FixtureMode>;
}

/** The mode fields a whole-instance seed may carry. */
export interface ModeSeed {
  readonly mode?: FixtureMode;
  readonly escalationToken?: string;
}

export function buildModeControl(request: ControlRequest): ModeControl {
  return {
    setMode: async (mode) => {
      await request('POST', '/__test/mode', { mode });
    },
    mode: async () => (await request<{ mode: FixtureMode }>('GET', '/__test/mode')).mode,
  };
}

function isMode(value: unknown): value is FixtureMode {
  return typeof value === 'string' && (FIXTURE_MODES as readonly string[]).includes(value);
}

export interface ModeState {
  mount(app: Express): void;
  /** The current mode, for the instance's `GET /__test/state`. */
  current(): FixtureMode;
  /** The token `hard-blocked` compares against, for `GET /__test/state`. */
  token(): string;
  /**
   * Applies the mode fields of a whole-instance seed and records them as the
   * baseline `reset` restores. Returns a message to refuse, having applied
   * neither field, so a bad token cannot leave a new mode installed.
   */
  seed(body: Record<string, unknown>): string | undefined;
  /** Returns mode and token to the baseline the last seed established. */
  reset(): void;
  /**
   * Serves a page through the instance's current mode. The site supplies both
   * layouts and stays ignorant of which one, if either, actually reaches the
   * client.
   */
  serve(request: Request, response: Response, page: (layout: Layout) => PageContent): void;
}

export function createModeState(): ModeState {
  let mode: FixtureMode = 'normal';
  let escalationToken = DEFAULT_ESCALATION_TOKEN;
  let baselineMode: FixtureMode = mode;
  let baselineToken = escalationToken;

  return {
    current: () => mode,
    token: () => escalationToken,

    seed(body) {
      const { mode: nextMode, escalationToken: nextToken } = body;
      if (nextMode !== undefined && !isMode(nextMode)) {
        return `mode must be one of ${FIXTURE_MODES.join(', ')}`;
      }
      if (nextToken !== undefined && (typeof nextToken !== 'string' || nextToken === '')) {
        return 'escalationToken must be a non-empty string';
      }
      if (nextMode !== undefined) {
        mode = nextMode;
      }
      if (typeof nextToken === 'string') {
        escalationToken = nextToken;
      }
      baselineMode = mode;
      baselineToken = escalationToken;
      return undefined;
    },

    reset() {
      mode = baselineMode;
      escalationToken = baselineToken;
    },

    mount(app) {
      app.get('/__test/mode', (_request, response) => {
        response.json({ mode });
      });

      app.post('/__test/mode', (request, response) => {
        const next = readRecord(request.body).mode;
        if (!isMode(next)) {
          // The instance keeps the mode it had; falling back to `normal` would
          // silently unblock a fixture a test believes is still blocked.
          response
            .status(400)
            .json({ error: `mode must be one of ${FIXTURE_MODES.join(', ')}`, mode });
          return;
        }
        mode = next;
        response.json({ mode });
      });
    },

    serve(request, response, page) {
      // `?mode=` is one-shot shorthand for a manual poke; it never writes the
      // instance's stored mode, because a mode that lives in the URL is a
      // different page rather than a site that changed under a live watch.
      const shorthand = request.query.mode;
      let effective = mode;
      if (shorthand !== undefined) {
        if (!isMode(shorthand)) {
          response.status(400).json({ error: `mode must be one of ${FIXTURE_MODES.join(', ')}` });
          return;
        }
        effective = shorthand;
      }

      const send = (layout: Layout): void => {
        const { title, main } = page(layout);
        response.type('text/html').send(documentShell({ title, state: NORMAL_STATE, main }));
      };

      switch (effective) {
        case 'normal':
          send('normal');
          return;
        case 'redesign':
          send('redesign');
          return;
        case 'blocked':
          response.type('text/html').send(blockedShellPage(page('normal').main));
          return;
        case 'hard-blocked':
          if (request.get(ESCALATION_HEADER) === escalationToken) {
            send('normal');
            return;
          }
          response.type('text/html').send(blockedShellPage());
          return;
      }
    },
  };
}
