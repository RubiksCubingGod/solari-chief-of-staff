/**
 * The only thing the chat tools are allowed to do.
 *
 * Every tool in `tools.ts` is a thin wrapper over one call through here, which
 * is what makes ARCHITECTURE §6's promise structural rather than a convention:
 * chat and the dashboard reach the same endpoints, with the same validation and
 * the same ownership rules, because chat has no other way in. There is no
 * database handle in this package.
 */
export type CrudResponse =
  | { readonly ok: true; readonly status: number; readonly body: unknown }
  /**
   * A refusal, with the server's own words for it. `reason` is what a user ends
   * up being told, so a generic "the request failed" here would be a downgrade
   * the person on the other end cannot recover from.
   */
  | { readonly ok: false; readonly status: number; readonly reason: string };

export type CrudMethod = 'GET' | 'POST' | 'PATCH';

export interface CrudClient {
  /**
   * `caller` is the user the message came from. It is a parameter rather than
   * client state because one client serves every chat in the process, and an
   * identity held on the client would be a cross-user leak one await apart.
   */
  request(caller: string, method: CrudMethod, path: string, body?: unknown): Promise<CrudResponse>;
}

/**
 * The headers that identify `caller` to the API.
 *
 * Identity is supplied to this client rather than invented by it. Until the
 * `dashboard-read` sprint landed authentication this client wrote its own
 * `x-user-id` header, which meant anything able to reach the API could claim to
 * be any user. The API now refuses that header outright.
 *
 * What a server-to-server caller should present instead is genuinely undecided.
 * The magic-link session is a browser credential, and minting one here would
 * forge exactly what that flow exists to prevent — so this seam names the gap
 * rather than hiding it behind a default that would be wrong in production.
 */
export type CrudCredential = (
  caller: string,
) => Record<string, string> | Promise<Record<string, string>>;

export interface HttpCrudClientOptions {
  /** Where the API server is, with no trailing slash required either way. */
  readonly baseUrl: string;
  /**
   * Required, and deliberately not defaulted: a client that guessed at identity
   * is precisely the hole the old header was.
   */
  readonly credential: CrudCredential;
  /** Injected only so a test can stand in for the network; production omits it. */
  readonly fetch?: typeof globalThis.fetch;
}

export function createHttpCrudClient(options: HttpCrudClientOptions): CrudClient {
  const base = options.baseUrl.replace(/\/+$/u, '');
  const send = options.fetch ?? globalThis.fetch;

  return {
    async request(caller, method, path, body) {
      // Resolved before the try, so a credential that fails is not reported as
      // the server being unreachable — which it is not.
      const identity = await options.credential(caller);
      let response: Response;
      try {
        response = await send(`${base}${path}`, {
          method,
          headers: {
            ...identity,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error: unknown) {
        // The API being unreachable is not different in kind from the API
        // refusing, as far as the model is concerned: both mean the effect did
        // not happen and the reply must not claim it did.
        return { ok: false, status: 0, reason: `the API could not be reached: ${message(error)}` };
      }

      const text = await response.text();
      if (response.ok) return { ok: true, status: response.status, body: parse(text) };
      return { ok: false, status: response.status, reason: refusalReason(response.status, text) };
    },
  };
}

/**
 * The reason out of an error envelope, field paths and all.
 *
 * The envelope's shape is `packages/api`'s, and it is read structurally here
 * rather than by importing its type: this package talks to that server over
 * HTTP, and a compile-time dependency on it would make the agent unbuildable
 * without the server it is deliberately only a client of.
 */
function refusalReason(status: number, text: string): string {
  const parsed = parse(text);
  const envelope = isRecord(parsed) ? parsed['error'] : undefined;
  if (!isRecord(envelope) || typeof envelope['message'] !== 'string') {
    return `the API answered ${String(status)}: ${text.slice(0, 200)}`;
  }
  const details = Array.isArray(envelope['details'])
    ? envelope['details'].filter(isRecord).map((detail) => {
        const path = typeof detail['path'] === 'string' && detail['path'] !== '' ? detail['path'] : '(body)';
        return `${path}: ${String(detail['message'])}`;
      })
    : [];
  return details.length === 0 ? envelope['message'] : `${envelope['message']} (${details.join('; ')})`;
}

function parse(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
