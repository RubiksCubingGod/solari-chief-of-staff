import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigError, loadConfig } from './config.js';

const DATABASE_URL = 'postgres://user@localhost:5432/chief_of_staff';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadConfig', () => {
  it('reads the real process environment when the caller passes nothing', () => {
    vi.stubEnv('DATABASE_URL', DATABASE_URL);
    vi.stubEnv('LOG_LEVEL', 'silent');

    expect(loadConfig().databaseUrl).toBe(DATABASE_URL);
    expect(loadConfig().logLevel).toBe('silent');
  });

  it('needs only a database url, and defaults the rest', () => {
    expect(loadConfig({ DATABASE_URL })).toEqual({
      databaseUrl: DATABASE_URL,
      host: '127.0.0.1',
      logLevel: 'info',
      port: 3000,
      runtimeEnvironment: 'development',
    });
  });

  it('reads every value the environment does supply', () => {
    expect(
      loadConfig({
        DATABASE_URL,
        HOST: '0.0.0.0',
        LOG_LEVEL: 'debug',
        NODE_ENV: 'production',
        PORT: '8080',
      }),
    ).toEqual({
      databaseUrl: DATABASE_URL,
      host: '0.0.0.0',
      logLevel: 'debug',
      port: 8080,
      runtimeEnvironment: 'production',
    });
  });

  it('treats a blank variable as absent rather than as an empty value', () => {
    const config = loadConfig({ DATABASE_URL: `  ${DATABASE_URL}  `, LOG_LEVEL: '   ', PORT: '' });

    expect(config.databaseUrl).toBe(DATABASE_URL);
    expect(config.logLevel).toBe('info');
    expect(config.port).toBe(3000);
  });

  it('reports every problem at once instead of only the first', () => {
    let caught: unknown;
    try {
      loadConfig({ LOG_LEVEL: 'chatty', NODE_ENV: 'staging', PORT: '70000' });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).problems).toEqual([
      'DATABASE_URL is required',
      'LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent, got ' +
        "'chatty'",
      "PORT must be an integer between 1 and 65535, got '70000'",
      "NODE_ENV must be one of development, test, production, got 'staging'",
    ]);
    expect((caught as ConfigError).message).toContain('- DATABASE_URL is required');
  });

  it('rejects a port that is not a whole number in range', () => {
    for (const value of ['0', '-1', '3000.5', 'http']) {
      expect(() => loadConfig({ DATABASE_URL, PORT: value })).toThrow(ConfigError);
    }
  });
});
