export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const RUNTIME_ENVIRONMENTS = ['development', 'test', 'production'] as const;
export type RuntimeEnvironment = (typeof RUNTIME_ENVIRONMENTS)[number];

export interface AppConfig {
  readonly databaseUrl: string;
  readonly host: string;
  readonly logLevel: LogLevel;
  readonly port: number;
  readonly runtimeEnvironment: RuntimeEnvironment;
}

/**
 * Raised when the process environment cannot produce a config. It carries every
 * problem at once: a deploy that is missing three variables should need one
 * restart to find that out, not three.
 */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((line) => `  - ${line}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

function required(
  environment: NodeJS.ProcessEnv,
  name: string,
  problems: string[],
): string | undefined {
  const value = environment[name]?.trim();
  if (value === undefined || value === '') {
    problems.push(`${name} is required`);
    return undefined;
  }
  return value;
}

function oneOf<T extends string>(
  environment: NodeJS.ProcessEnv,
  name: string,
  allowed: readonly T[],
  fallback: T,
  problems: string[],
): T {
  const value = environment[name]?.trim();
  if (value === undefined || value === '') return fallback;
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    problems.push(`${name} must be one of ${allowed.join(', ')}, got '${value}'`);
    return fallback;
  }
  return match;
}

function port(environment: NodeJS.ProcessEnv, name: string, problems: string[]): number {
  const value = environment[name]?.trim();
  if (value === undefined || value === '') return 3000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    problems.push(`${name} must be an integer between 1 and 65535, got '${value}'`);
    return 3000;
  }
  return parsed;
}

/**
 * Reads the whole configuration out of an environment object. Nothing here
 * touches `process.env` unless the caller lets it default, so a test can hand
 * over an exact environment instead of mutating the real one.
 */
export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const problems: string[] = [];
  const databaseUrl = required(environment, 'DATABASE_URL', problems);
  const config: AppConfig = {
    databaseUrl: databaseUrl ?? '',
    host: environment['HOST']?.trim() ?? '127.0.0.1',
    logLevel: oneOf(environment, 'LOG_LEVEL', LOG_LEVELS, 'info', problems),
    port: port(environment, 'PORT', problems),
    runtimeEnvironment: oneOf(
      environment,
      'NODE_ENV',
      RUNTIME_ENVIRONMENTS,
      'development',
      problems,
    ),
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
