import type {
  CalendarItemKind,
  CalendarItemStatus,
  TaskKind,
  TaskMode,
  TaskStatus,
  TierPolicy,
  WatchKind,
  WatchStatus,
} from '@chief-of-staff/core';

/**
 * The dashboard's only way to reach its data. Everything here speaks HTTP to
 * the Fastify server; the database is deliberately out of reach, and
 * `eslint.config.js` refuses an import that would put it back within reach.
 *
 * The rows below are the JSON the server sends, not the Drizzle rows it reads:
 * timestamps have already become ISO strings and dates `YYYY-MM-DD`, which is
 * why they are declared here rather than imported from the schema.
 */

export interface Watch {
  readonly id: string;
  readonly userId: string;
  readonly kind: WatchKind;
  readonly url: string;
  readonly extractor: unknown;
  readonly condition: unknown;
  readonly schedule: string;
  readonly tierPolicy: TierPolicy;
  readonly status: WatchStatus;
  readonly lastValue: unknown;
  readonly lastCheckedAt: string | null;
  readonly consecutiveFailures: number;
}

export interface CalendarItem {
  readonly id: string;
  readonly userId: string;
  readonly kind: CalendarItemKind;
  readonly name: string;
  readonly amountCents: number | null;
  readonly renewOn: string | null;
  readonly cancelBy: string | null;
  readonly action: unknown;
  readonly status: CalendarItemStatus;
}

export interface Task {
  readonly id: string;
  readonly userId: string;
  readonly kind: TaskKind;
  readonly input: unknown;
  readonly status: TaskStatus;
  readonly mode: TaskMode;
  readonly playbookId: string | null;
  readonly solariSessionId: string | null;
  readonly recordingUrl: string | null;
  readonly result: unknown;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

export interface HealthReport {
  readonly status: string;
}

/** One rejected field, addressed by JSON Pointer, exactly as the server sends it. */
export interface ApiErrorDetail {
  readonly path: string;
  readonly message: string;
}

/**
 * The codes `packages/api/src/errors.ts` publishes. The server owns the list;
 * this is the client's copy of it, and `code` stays a plain string so a code
 * added there surfaces here as an unrecognised refusal rather than as a crash.
 */
export const API_ERROR_CODES = [
  'bad_request',
  'malformed_json',
  'validation_failed',
  'not_found',
  'method_not_allowed',
  'payload_too_large',
  'unsupported_media_type',
  'internal_error',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** Stands in for the code of a refusal whose body was not an error envelope. */
export const UNKNOWN_ERROR_CODE = 'unknown';

export function isApiErrorCode(code: string): code is ApiErrorCode {
  return API_ERROR_CODES.some((declared) => declared === code);
}

/**
 * A refusal the server described. Callers branch on `code`, never on `message`:
 * the wording is free to change and the codes are the contract.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: readonly ApiErrorDetail[];

  constructor(status: number, code: string, message: string, details: readonly ApiErrorDetail[]) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * The server never answered at all. Separate from {@link ApiError} because the
 * two want opposite things from a page: a refusal is data to render, an
 * unreachable API is an outage to report.
 */
export class ApiUnreachableError extends Error {
  readonly url: string;

  constructor(url: string, cause: unknown) {
    super(`The API at ${url} did not answer.`, { cause });
    this.name = 'ApiUnreachableError';
    this.url = url;
  }
}

/**
 * Everything the API needs in order to know who is asking, expressed as
 * headers. Today the server identifies a caller by an `x-user-id` header; when
 * magic-link auth lands in this same sprint it becomes a session cookie, and
 * this interface is the only thing that has to change - not the call sites.
 */
export interface ApiCredential {
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Resolved per request rather than captured once, so a credential that expires
 * mid-session can be refreshed without rebuilding the client.
 */
export type CredentialSource = () => ApiCredential | Promise<ApiCredential>;

/** The header `packages/api/src/caller.ts` reads the caller's identity from. */
export const CALLER_HEADER = 'x-user-id';

export function callerIdCredential(userId: string): CredentialSource {
  return () => ({ headers: { [CALLER_HEADER]: userId } });
}

/** For the calls that identify nobody, such as the health probe. */
export const anonymousCredential: CredentialSource = () => ({ headers: {} });

/** The slice of `fetch` this client uses, so a test can hand over its own. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly credential?: CredentialSource;
  readonly fetch?: FetchLike;
}

export interface ApiClient {
  health(): Promise<HealthReport>;
  listWatches(): Promise<readonly Watch[]>;
  setWatchStatus(id: string, status: WatchStatus): Promise<Watch>;
  listCalendarItems(): Promise<readonly CalendarItem[]>;
  listTasks(): Promise<readonly Task[]>;
}

function readEnvelope(body: unknown): { code: string; message: string; details: ApiErrorDetail[] } | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { error } = body as { error?: unknown };
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, message, details } = error as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
  if (typeof code !== 'string' || typeof message !== 'string') return undefined;
  return {
    code,
    message,
    details: Array.isArray(details) ? (details as ApiErrorDetail[]) : [],
  };
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const baseUrl = options.baseUrl;
  const credential = options.credential ?? anonymousCredential;
  const send = options.fetch ?? ((input, init) => fetch(input, init));

  async function request<T>(method: 'GET' | 'PATCH', path: string, body?: unknown): Promise<T> {
    const url = `${baseUrl}${path}`;
    const { headers } = await credential();
    let response: Response;
    try {
      response = await send(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      throw new ApiUnreachableError(url, cause);
    }

    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const envelope = readEnvelope(payload);
      throw envelope === undefined
        ? new ApiError(
            response.status,
            UNKNOWN_ERROR_CODE,
            `${method} ${path} was refused with ${String(response.status)} and no error envelope.`,
            [],
          )
        : new ApiError(response.status, envelope.code, envelope.message, envelope.details);
    }
    return payload as T;
  }

  return {
    health: () => request<HealthReport>('GET', '/health'),
    listWatches: () => request<readonly Watch[]>('GET', '/watches'),
    setWatchStatus: (id, status) =>
      request<Watch>('PATCH', `/watches/${encodeURIComponent(id)}`, { status }),
    listCalendarItems: () => request<readonly CalendarItem[]>('GET', '/calendar-items'),
    listTasks: () => request<readonly Task[]>('GET', '/tasks'),
  };
}
