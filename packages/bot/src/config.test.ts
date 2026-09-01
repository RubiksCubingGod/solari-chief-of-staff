import { describe, expect, it } from 'vitest';

import { BotConfigError, loadBotConfig } from './config.js';

const MINIMAL = {
  TELEGRAM_BOT_TOKEN: '123456:test-token',
  DATABASE_URL: 'postgres://user@localhost:5432/chief_of_staff',
} as const;

function problems(environment: NodeJS.ProcessEnv): readonly string[] {
  try {
    loadBotConfig(environment);
  } catch (error) {
    if (error instanceof BotConfigError) return error.problems;
    throw error;
  }
  throw new Error('the configuration was accepted when it should not have been');
}

describe('loadBotConfig', () => {
  it('long-polls by default, which is what a developer running it locally wants', () => {
    const config = loadBotConfig({ ...MINIMAL });

    expect(config.transport).toBe('polling');
    expect(config.token).toBe(MINIMAL.TELEGRAM_BOT_TOKEN);
    expect(config.databaseUrl).toBe(MINIMAL.DATABASE_URL);
    expect(config.webhookUrl).toBeUndefined();
    expect(config.webhookSecret).toBeUndefined();
  });

  it('reports every missing variable at once', () => {
    // One restart should reveal the whole list, not the first item of it.
    expect(problems({})).toEqual([
      'TELEGRAM_BOT_TOKEN is required',
      'DATABASE_URL is required',
    ]);
  });

  it('refuses a transport it cannot run', () => {
    expect(problems({ ...MINIMAL, TELEGRAM_TRANSPORT: 'carrier-pigeon' })).toEqual([
      "TELEGRAM_TRANSPORT must be one of polling, webhook, got 'carrier-pigeon'",
    ]);
  });

  it('requires the webhook URL that webhook mode is meaningless without', () => {
    expect(problems({ ...MINIMAL, TELEGRAM_TRANSPORT: 'webhook' })).toEqual([
      'TELEGRAM_WEBHOOK_URL is required when TELEGRAM_TRANSPORT is webhook',
    ]);
  });

  it('accepts webhook mode once it has somewhere to point', () => {
    const config = loadBotConfig({
      ...MINIMAL,
      TELEGRAM_TRANSPORT: 'webhook',
      TELEGRAM_WEBHOOK_URL: 'https://bot.example/telegram',
      TELEGRAM_WEBHOOK_SECRET: 'shh',
    });

    expect(config.transport).toBe('webhook');
    expect(config.webhookUrl).toBe('https://bot.example/telegram');
    expect(config.webhookSecret).toBe('shh');
  });

  it('refuses a webhook URL that is not https, because Telegram will not call it', () => {
    expect(
      problems({
        ...MINIMAL,
        TELEGRAM_TRANSPORT: 'webhook',
        TELEGRAM_WEBHOOK_URL: 'http://bot.example/telegram',
      }),
    ).toEqual(['TELEGRAM_WEBHOOK_URL must be an https URL, got http://bot.example/telegram']);
  });

  it('ignores a webhook URL that polling mode would never call', () => {
    const config = loadBotConfig({
      ...MINIMAL,
      TELEGRAM_WEBHOOK_URL: 'https://bot.example/telegram',
    });

    expect(config.transport).toBe('polling');
    expect(config.webhookUrl).toBeUndefined();
  });

  it('defaults the rate limit to something a person cannot trip but a script can', () => {
    const config = loadBotConfig({ ...MINIMAL });

    expect(config.rateLimit).toEqual({
      burst: 10,
      refillPerMinute: 20,
      noticeWindowMs: 60_000,
    });
  });

  it('takes rate-limit overrides', () => {
    const config = loadBotConfig({
      ...MINIMAL,
      TELEGRAM_RATE_LIMIT_BURST: '3',
      TELEGRAM_RATE_LIMIT_PER_MINUTE: '6',
      TELEGRAM_RATE_LIMIT_NOTICE_SECONDS: '30',
    });

    expect(config.rateLimit).toEqual({
      burst: 3,
      refillPerMinute: 6,
      noticeWindowMs: 30_000,
    });
  });

  it.each([
    ['TELEGRAM_RATE_LIMIT_BURST', '0'],
    ['TELEGRAM_RATE_LIMIT_BURST', '1.5'],
    ['TELEGRAM_RATE_LIMIT_PER_MINUTE', '-1'],
    ['TELEGRAM_RATE_LIMIT_NOTICE_SECONDS', 'often'],
  ])('refuses %s=%s rather than limiting nothing', (name, value) => {
    // A bucket configured to zero or a fraction silently stops refusing
    // anything, which is the one failure a rate limiter must not have.
    expect(problems({ ...MINIMAL, [name]: value })).toEqual([
      `${name} must be a positive integer, got '${value}'`,
    ]);
  });
});
