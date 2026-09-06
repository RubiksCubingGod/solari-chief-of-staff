export const BOT_TRANSPORTS = ['polling', 'webhook'] as const;
export type BotTransport = (typeof BOT_TRANSPORTS)[number];

/**
 * A per-chat token bucket. `burst` is how much a chat may spend at once,
 * `refillPerMinute` how fast it earns more, and `noticeWindowMs` how often a
 * chat that has run out is told so — the refusal itself is unconditional, but
 * repeating the explanation to a flooding script would be its own flood.
 */
export interface RateLimitPolicy {
  readonly burst: number;
  readonly refillPerMinute: number;
  readonly noticeWindowMs: number;
}

export interface BotConfig {
  readonly token: string;
  readonly transport: BotTransport;
  /** Set only in webhook mode; polling never calls back. */
  readonly webhookUrl: string | undefined;
  readonly webhookSecret: string | undefined;
  readonly databaseUrl: string;
  readonly rateLimit: RateLimitPolicy;
}

/**
 * Raised when the process environment cannot produce a bot config, carrying
 * every problem at once for the same reason the API's `ConfigError` does: a
 * deploy missing three variables should need one restart to learn that, not
 * three. The two are deliberately not shared — `packages/api` is a consumer of
 * this bot's outbound door, not a dependency of it, and importing a server to
 * read an environment variable would invert that.
 */
export class BotConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid bot configuration:\n${problems.map((line) => `  - ${line}`).join('\n')}`);
    this.name = 'BotConfigError';
    this.problems = problems;
  }
}

function trimmed(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = environment[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function required(
  environment: NodeJS.ProcessEnv,
  name: string,
  problems: string[],
): string | undefined {
  const value = trimmed(environment, name);
  if (value === undefined) problems.push(`${name} is required`);
  return value;
}

function positiveInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  problems: string[],
): number {
  const value = trimmed(environment, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    problems.push(`${name} must be a positive integer, got '${value}'`);
    return fallback;
  }
  return parsed;
}

function transportOf(environment: NodeJS.ProcessEnv, problems: string[]): BotTransport {
  const value = trimmed(environment, 'TELEGRAM_TRANSPORT');
  if (value === undefined) return 'polling';
  const match = BOT_TRANSPORTS.find((candidate) => candidate === value);
  if (match === undefined) {
    problems.push(
      `TELEGRAM_TRANSPORT must be one of ${BOT_TRANSPORTS.join(', ')}, got '${value}'`,
    );
    return 'polling';
  }
  return match;
}

/**
 * Reads the whole bot configuration out of an environment object, taking the
 * same shape as `loadConfig` in `packages/api`: nothing here touches
 * `process.env` unless the caller lets it default, so a test hands over an
 * exact environment instead of mutating the real one.
 */
export function loadBotConfig(environment: NodeJS.ProcessEnv = process.env): BotConfig {
  const problems: string[] = [];
  const token = required(environment, 'TELEGRAM_BOT_TOKEN', problems);
  const databaseUrl = required(environment, 'DATABASE_URL', problems);
  const transport = transportOf(environment, problems);

  // Read only in webhook mode. A leftover URL from an earlier deployment should
  // not look like configuration in a process that will never call it.
  const webhookUrl = transport === 'webhook' ? webhookUrlOf(environment, problems) : undefined;
  const webhookSecret =
    transport === 'webhook' ? trimmed(environment, 'TELEGRAM_WEBHOOK_SECRET') : undefined;

  const config: BotConfig = {
    token: token ?? '',
    transport,
    webhookUrl,
    webhookSecret,
    databaseUrl: databaseUrl ?? '',
    rateLimit: {
      burst: positiveInteger(environment, 'TELEGRAM_RATE_LIMIT_BURST', 10, problems),
      refillPerMinute: positiveInteger(environment, 'TELEGRAM_RATE_LIMIT_PER_MINUTE', 20, problems),
      noticeWindowMs:
        positiveInteger(environment, 'TELEGRAM_RATE_LIMIT_NOTICE_SECONDS', 60, problems) * 1000,
    },
  };

  if (problems.length > 0) throw new BotConfigError(problems);
  return config;
}

function webhookUrlOf(environment: NodeJS.ProcessEnv, problems: string[]): string | undefined {
  const value = trimmed(environment, 'TELEGRAM_WEBHOOK_URL');
  if (value === undefined) {
    problems.push('TELEGRAM_WEBHOOK_URL is required when TELEGRAM_TRANSPORT is webhook');
    return undefined;
  }
  // Telegram refuses to deliver to anything but https, so an http URL here is a
  // bot that silently receives nothing rather than one that fails loudly.
  if (!value.startsWith('https://')) {
    problems.push(`TELEGRAM_WEBHOOK_URL must be an https URL, got ${value}`);
    return undefined;
  }
  return value;
}
