import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { API_BASE_URL_VARIABLE, WebConfigError, loadWebConfig } from './config';

describe('loadWebConfig', () => {
  it('reads the API origin out of the environment it is handed', () => {
    expect(loadWebConfig({ [API_BASE_URL_VARIABLE]: 'https://api.example.com' })).toEqual({
      apiBaseUrl: 'https://api.example.com',
    });
  });

  it('drops a trailing slash so a request path can always start with one', () => {
    expect(loadWebConfig({ [API_BASE_URL_VARIABLE]: 'https://api.example.com//' })).toEqual({
      apiBaseUrl: 'https://api.example.com',
    });
  });

  it('refuses an environment that names no API at all', () => {
    for (const environment of [{}, { [API_BASE_URL_VARIABLE]: '   ' }]) {
      expect(() => loadWebConfig(environment)).toThrow(WebConfigError);
    }
  });

  it('refuses a value that is not an absolute URL', () => {
    try {
      loadWebConfig({ [API_BASE_URL_VARIABLE]: '/api' });
      expect.unreachable('a relative path is not an origin');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(WebConfigError);
      expect((error as WebConfigError).problems).toEqual([
        `${API_BASE_URL_VARIABLE} must be an absolute URL, got '/api'`,
      ]);
    }
  });

  it('refuses a scheme the dashboard cannot speak', () => {
    // The point of the boundary is that the dashboard reaches its data over
    // HTTP; a connection string here would be somebody routing around that.
    try {
      loadWebConfig({ [API_BASE_URL_VARIABLE]: 'postgres://localhost:5432/chief_of_staff' });
      expect.unreachable('a database URL is not an API origin');
    } catch (error: unknown) {
      expect((error as WebConfigError).problems).toHaveLength(1);
      expect((error as WebConfigError).problems[0]).toMatch(/must be an http or https URL/u);
    }
  });

  it('names every problem in the message, not just the first', () => {
    const error = new WebConfigError(['one is required', 'two is required']);

    expect(error.message).toContain('one is required');
    expect(error.message).toContain('two is required');
  });
});

describe('.env.example', () => {
  it('documents the variable the dashboard cannot start without', () => {
    // The same invariant `tests/docs.test.ts` holds the server to: a variable
    // this package reads and the example file does not mention is a variable
    // nobody knows to set.
    const example = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
    const documented = Object.fromEntries(
      example
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'))
        .map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)] as const;
        }),
    );

    expect(Object.keys(documented)).toContain(API_BASE_URL_VARIABLE);
    expect(loadWebConfig(documented).apiBaseUrl).toBeTruthy();
  });
});
