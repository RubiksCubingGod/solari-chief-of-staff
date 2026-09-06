import {
  ApiError,
  ApiUnreachableError,
  UNKNOWN_ERROR_CODE,
  sessionCookieCredential,
  type ApiErrorDetail,
  type CredentialSource,
  type FetchLike,
} from '../api-client';
import { loadWebConfig } from '../config';

/**
 * The dashboard's view of the API's site-connection routes.
 *
 * Its own client rather than five more methods on `ApiClient`, because the
 * shape is different in the one way that matters to a caller: an attempt is a
 * thing that expires, and the page that shows one has to be ready for the API
 * to say it is gone. The refusals are the same classes the main client throws,
 * so `describeRefusal` reads them without knowing which client they came from.
 */

export type ConnectAttemptStatus = 'started' | 'confirmed' | 'cancelled' | 'expired';

export interface ConnectAttempt {
  readonly id: string;
  readonly siteDomain: string;
  readonly status: ConnectAttemptStatus;
  /** The name to find in the vendor console's profile list. */
  readonly profileName: string;
  /** The console's profile list, where "Open editor" is. */
  readonly editorUrl: string;
  /** This dashboard's page for the attempt, as the API spells it. */
  readonly confirmUrl: string;
  readonly startedAt: string;
  readonly expiresAt: string;
}

export type SiteConnectionStatus = 'connected' | 'expired';

export interface SiteConnection {
  readonly id: string;
  readonly siteDomain: string;
  readonly status: SiteConnectionStatus;
  readonly lastUsedAt: string | null;
}

export interface ConnectClient {
  startAttempt(siteDomain: string): Promise<ConnectAttempt>;
  readAttempt(id: string): Promise<ConnectAttempt>;
  confirmAttempt(id: string): Promise<SiteConnection>;
  cancelAttempt(id: string): Promise<void>;
  listConnections(): Promise<readonly SiteConnection[]>;
}

export interface ConnectClientOptions {
  readonly baseUrl: string;
  readonly credential: CredentialSource;
  readonly fetch?: FetchLike;
}

type Method = 'GET' | 'POST' | 'DELETE';

interface Envelope {
  readonly code: string;
  readonly message: string;
  readonly details: readonly ApiErrorDetail[];
}

function readEnvelope(body: unknown): Envelope | undefined {
  if (typeof body !== 'object' || body === null || !('error' in body)) return undefined;
  const error = body.error;
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, message, details } = error as Record<string, unknown>;
  if (typeof code !== 'string' || typeof message !== 'string') return undefined;
  return { code, message, details: Array.isArray(details) ? (details as ApiErrorDetail[]) : [] };
}

async function refusal(response: Response, method: Method, path: string): Promise<ApiError> {
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

export function createConnectClient(options: ConnectClientOptions): ConnectClient {
  const send = options.fetch ?? ((input, init) => fetch(input, init));

  async function exchange(method: Method, path: string, body?: unknown): Promise<Response> {
    const url = `${options.baseUrl}${path}`;
    const { headers } = await options.credential();
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
    // Outside the try on purpose: a `fetch` that resolved to something that is
    // not a response is a defect in this process, and the TypeError it throws
    // here should say so rather than be dressed as the API being away.
    if (!response.ok) throw await refusal(response, method, path);
    return response;
  }

  async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const response = await exchange(method, path, body);
    return (await response.json().catch(() => undefined)) as T;
  }

  const attemptPath = (id: string): string => `/site-connections/attempts/${encodeURIComponent(id)}`;

  return {
    startAttempt: (siteDomain) =>
      request<ConnectAttempt>('POST', '/site-connections/attempts', { siteDomain }),
    readAttempt: (id) => request<ConnectAttempt>('GET', attemptPath(id)),
    confirmAttempt: (id) => request<SiteConnection>('POST', `${attemptPath(id)}/confirm`),
    cancelAttempt: async (id) => {
      await exchange('DELETE', attemptPath(id));
    },
    listConnections: () => request<readonly SiteConnection[]>('GET', '/site-connections'),
  };
}

/** The client a page or route uses, speaking as the browser's own session cookie. */
export function connectClientForCookie(cookieHeader: string): ConnectClient {
  return createConnectClient({
    baseUrl: loadWebConfig().apiBaseUrl,
    credential: sessionCookieCredential(cookieHeader),
  });
}
