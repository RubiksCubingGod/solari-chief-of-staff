/** The one variable the dashboard cannot start without. */
export const API_BASE_URL_VARIABLE = 'API_BASE_URL';

/**
 * Just enough of an environment to read from. Spelled out rather than taken
 * from `NodeJS.ProcessEnv`, because Next augments that global with its own
 * required members and this package would then be unable to describe a two-key
 * environment in a test.
 */
export type Environment = Readonly<Record<string, string | undefined>>;

export interface WebConfig {
  /** Origin of the API, with no trailing slash. */
  readonly apiBaseUrl: string;
}

/**
 * Raised when the environment cannot produce a config. Like the server's own
 * `ConfigError` it carries every problem at once: a deployment missing two
 * variables should learn both in one boot, not one per restart.
 */
export class WebConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid dashboard configuration:\n${problems.map((line) => `  - ${line}`).join('\n')}`);
    this.name = 'WebConfigError';
    this.problems = problems;
  }
}

function origin(environment: Environment, name: string, problems: string[]): string {
  const value = environment[name]?.trim();
  if (value === undefined || value === '') {
    problems.push(`${name} is required`);
    return '';
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    problems.push(`${name} must be an absolute URL, got '${value}'`);
    return '';
  }
  // The dashboard reaches the API over HTTP and nothing else. A `file:` or
  // `postgres:` URL here is somebody wiring the dashboard straight at the
  // database, which is exactly what this package is not allowed to do.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    problems.push(`${name} must be an http or https URL, got '${value}'`);
    return '';
  }
  // Trailing slashes are dropped here so every request path in the client can
  // be written with a leading one and mean the same thing.
  return value.replace(/\/+$/u, '');
}

/**
 * Reads the whole dashboard configuration out of an environment object.
 * Nothing else in this package touches `process.env`, so a page renders from
 * values it was handed and a test hands over an exact environment instead of
 * mutating the real one.
 */
export function loadWebConfig(environment: Environment = process.env): WebConfig {
  const problems: string[] = [];
  const apiBaseUrl = origin(environment, API_BASE_URL_VARIABLE, problems);
  if (problems.length > 0) throw new WebConfigError(problems);
  return { apiBaseUrl };
}
