/**
 * Every 4xx and 5xx response this server produces has this shape. Clients
 * branch on `code`, never on `message`, so the wording stays free to change.
 */
export interface ErrorEnvelope {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly details?: readonly ErrorDetail[];
  };
}

/** One rejected field, addressed by JSON Pointer so nested bodies stay legible. */
export interface ErrorDetail {
  readonly path: string;
  readonly message: string;
}

export const ERROR_CODES = [
  'bad_request',
  'malformed_json',
  'validation_failed',
  // A request that named nobody the server believes. Distinct from
  // `not_found`, which is what a caller who *is* somebody is told about a row
  // that is not theirs: the two answer different questions and a client that
  // conflated them would offer a login to somebody who is already logged in.
  'unauthorized',
  'not_found',
  'method_not_allowed',
  'payload_too_large',
  'unsupported_media_type',
  'internal_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function errorEnvelope(
  code: ErrorCode,
  message: string,
  details?: readonly ErrorDetail[],
): ErrorEnvelope {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

/**
 * One Ajv violation, narrowed to the two fields the envelope needs. Ajv only
 * omits `message` when it is built with `messages: false`, which this server
 * does not do, but the type stays honest and the fallback stays tested.
 */
export interface SchemaViolation {
  readonly instancePath: string;
  readonly message?: string | undefined;
}

export function violationDetails(violations: readonly SchemaViolation[]): ErrorDetail[] {
  return violations.map((violation) => ({
    path: violation.instancePath,
    message: violation.message ?? 'is invalid',
  }));
}

/**
 * A refusal a handler raises itself, for the cases JSON Schema cannot see: a
 * row that does not exist, or one that belongs to somebody else. It carries the
 * envelope code so the error handler does not have to guess one from the status.
 */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  /**
   * Per-field refusals, for a handler that judged a body JSON Schema had
   * already accepted: the shape was right, the meaning was not. They travel in
   * the envelope's `details` exactly as schema violations do, so a client
   * fixing a form does not have to know which layer refused it.
   */
  readonly details: readonly ErrorDetail[] | undefined;

  constructor(statusCode: number, code: ErrorCode, message: string, details?: readonly ErrorDetail[]) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

/** Narrows an arbitrary error `code` to one this server declares. */
export function declaredErrorCode(code: unknown): ErrorCode | undefined {
  return ERROR_CODES.find((declared) => declared === code);
}
