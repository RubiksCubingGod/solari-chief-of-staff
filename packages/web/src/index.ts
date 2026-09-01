/**
 * What the dashboard is made of, for anything that is not a page: the
 * configuration it reads and the client it reaches the API through. The pages
 * themselves live under `src/app` and are entered by Next, not by an import.
 */

export {
  API_BASE_URL_VARIABLE,
  WebConfigError,
  loadWebConfig,
  type Environment,
  type WebConfig,
} from './config';

export {
  API_ERROR_CODES,
  ApiError,
  ApiUnreachableError,
  UNKNOWN_ERROR_CODE,
  anonymousCredential,
  createApiClient,
  isApiErrorCode,
  sessionCookieCredential,
  type ApiClient,
  type ApiClientOptions,
  type ApiCredential,
  type ApiErrorCode,
  type ApiErrorDetail,
  type AuthenticatedUser,
  type CalendarItem,
  type CredentialSource,
  type FetchLike,
  type HealthReport,
  type Task,
  type Watch,
} from './api-client';

export {
  REQUEST_LINK_PATH,
  SESSION_COOKIE_NAME,
  readSession,
  type Session,
} from './auth/session';
