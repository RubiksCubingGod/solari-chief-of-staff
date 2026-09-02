import type {
  CalendarItemKind,
  CalendarItemStatus,
  FetchTier,
  TaskEventType,
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

/**
 * One check of one watch, as `GET /watches/:id/observations` sends it.
 *
 * `value` is `unknown` because it is whatever the extractor pulled off the
 * page: a price is a number, a slot is a string, a change is a document. Only
 * the caller knows what it asked for, so nothing here pretends to.
 */
export interface Observation {
  readonly id: string;
  readonly watchId: string;
  readonly checkedAt: string;
  readonly tierUsed: FetchTier;
  readonly value: unknown;
  readonly triggered: boolean;
  readonly error: string | null;
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

/** One event of a task's trail, as the ledger wrote it. */
export interface TaskEvent {
  /** The ledger's own order: ascending is the order things happened. */
  readonly seq: number;
  readonly ts: string;
  readonly type: TaskEventType;
  /** Shaped by `type`; see `task-lifecycle.ts` in core. Read defensively. */
  readonly payload: unknown;
}

/** Whether a task has a recording, and where the API serves it from. */
export interface RecordingReference {
  readonly available: boolean;
  readonly href?: string;
}

/** One task with everything the detail page draws: the row, its trail, its recording. */
export interface TaskDetail extends Task {
  readonly events: readonly TaskEvent[];
  readonly recording: RecordingReference;
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
  'unauthorized',
  'not_found',
  'method_not_allowed',
  'payload_too_large',
  'unsupported_media_type',
  'internal_error',
  // The API fetched something on the caller's behalf - a task's recording -
  // and its store refused or did not answer.
  'upstream_unavailable',
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
 * headers. This used to carry an `x-user-id` header naming the caller; magic
 * link auth landed in this same sprint and it now carries the session cookie
 * the browser presented, which is the whole of the change the interface existed
 * to absorb - no call site moved.
 */
export interface ApiCredential {
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Resolved per request rather than captured once, so a credential that expires
 * mid-session can be refreshed without rebuilding the client.
 */
export type CredentialSource = () => ApiCredential | Promise<ApiCredential>;

/**
 * The caller, as `GET /auth/session` describes them. `email` is nullable
 * because an account can be seeded or bound through Telegram before anyone has
 * told us where to write to them.
 */
export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string | null;
}

/**
 * Forwards the browser's own `Cookie` header, unread.
 *
 * The dashboard never parses, verifies or re-signs it - it holds no key and
 * could not - so the credential is the header verbatim and the API is the only
 * thing that decides what it is worth. A cookie the dashboard could interpret
 * would be a cookie the dashboard could forge.
 */
export function sessionCookieCredential(cookieHeader: string): CredentialSource {
  return () => ({ headers: { cookie: cookieHeader } });
}

/** For the calls that identify nobody: the health probe, and asking for a link. */
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
  /** Who the credential speaks for. Refused with 401 when it speaks for nobody. */
  session(): Promise<AuthenticatedUser>;
  /**
   * Asks for a magic link. Answers the same way whether or not the address has
   * an account, so there is nothing here for a caller to branch on.
   */
  requestLink(email: string): Promise<void>;
  listWatches(): Promise<readonly Watch[]>;
  /**
   * One watch's recent checks, oldest first - the order a sparkline plots, and
   * the order the server already sends, so no caller reverses it.
   *
   * A watch belonging to somebody else is refused as `not_found`, the same as
   * one that never existed, so a caller cannot learn an id is real by asking.
   */
  listObservations(watchId: string): Promise<readonly Observation[]>;
  setWatchStatus(id: string, status: WatchStatus): Promise<Watch>;
  listCalendarItems(): Promise<readonly CalendarItem[]>;
  listTasks(): Promise<readonly Task[]>;
  /** One task with its trail and recording reference; 404 for a stranger's. */
  getTask(id: string): Promise<TaskDetail>;
  /** The task's recording as NDJSON text, whatever the store kept it as. */
  readTaskRecording(id: string): Promise<string>;
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

/** The refusal a response carries, read from its envelope when it has one. */
async function refusal(response: Response, method: string, path: string): Promise<ApiError> {
  const envelope = readEnvelope(await response.json().catch(() => undefined));
  return envelope === undefined
    ? new ApiError(
        response.status,
        UNKNOWN_ERROR_CODE,
        `${method} ${path} was refused with ${String(response.status)} and no error envelope.`,
        [],
      )
    : new ApiError(response.status, envelope.code, envelope.message, envelope.details);
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const baseUrl = options.baseUrl;
  const credential = options.credential ?? anonymousCredential;
  const send = options.fetch ?? ((input, init) => fetch(input, init));

  async function exchange(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    accept: string,
    body?: unknown,
  ): Promise<Response> {
    const url = `${baseUrl}${path}`;
    const { headers } = await credential();
    let response: Response;
    try {
      response = await send(url, {
        method,
        headers: {
          accept,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      throw new ApiUnreachableError(url, cause);
    }
    if (!response.ok) throw await refusal(response, method, path);
    return response;
  }

  async function request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await exchange(method, path, 'application/json', body);
    return (await response.json().catch(() => undefined)) as T;
  }

  return {
    health: () => request<HealthReport>('GET', '/health'),
    session: () => request<AuthenticatedUser>('GET', '/auth/session'),
    requestLink: async (email) => {
      await request<unknown>('POST', '/auth/request-link', { email });
    },
    listWatches: () => request<readonly Watch[]>('GET', '/watches'),
    listObservations: (watchId) =>
      request<readonly Observation[]>(
        'GET',
        `/watches/${encodeURIComponent(watchId)}/observations`,
      ),
    setWatchStatus: (id, status) =>
      request<Watch>('PATCH', `/watches/${encodeURIComponent(id)}`, { status }),
    listCalendarItems: () => request<readonly CalendarItem[]>('GET', '/calendar-items'),
    listTasks: () => request<readonly Task[]>('GET', '/tasks'),
    getTask: (id) => request<TaskDetail>('GET', `/tasks/${encodeURIComponent(id)}`),
    readTaskRecording: async (id) => {
      const response = await exchange(
        'GET',
        `/tasks/${encodeURIComponent(id)}/recording`,
        'application/x-ndjson',
      );
      return response.text();
    },
  };
}
