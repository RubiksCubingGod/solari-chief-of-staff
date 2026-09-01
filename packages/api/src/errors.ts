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
