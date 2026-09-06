import { describe, expect, it } from 'vitest';

import { checkUrl, hostAllowed, normalizeHost } from './allowlist.js';

describe('normalizeHost', () => {
  it('ignores case, a wildcard prefix, and a trailing dot', () => {
    expect(normalizeHost(' *.Example.COM. ')).toBe('example.com');
  });
});

describe('hostAllowed', () => {
  const allowlist = ['fakegym.test', '127.0.0.1'];

  it('admits the host itself and every host under it', () => {
    expect(hostAllowed('fakegym.test', allowlist)).toBe(true);
    expect(hostAllowed('www.fakegym.test', allowlist)).toBe(true);
    expect(hostAllowed('FAKEGYM.TEST', allowlist)).toBe(true);
    expect(hostAllowed('127.0.0.1', allowlist)).toBe(true);
  });

  it('refuses a host that merely ends with an allowed name, an unrelated one, and an empty one', () => {
    expect(hostAllowed('notfakegym.test', allowlist)).toBe(false);
    expect(hostAllowed('fakegym.test.evil.example', allowlist)).toBe(false);
    expect(hostAllowed('localhost', allowlist)).toBe(false);
    expect(hostAllowed('', allowlist)).toBe(false);
  });

  it('treats an empty list, or a blank entry, as admitting nothing', () => {
    expect(hostAllowed('anything.test', [])).toBe(false);
    expect(hostAllowed('anything.test', ['', ' '])).toBe(false);
  });
});

describe('checkUrl', () => {
  const allowlist = ['fakegym.test'];

  it('allows a web URL on the list, whatever its port, path, or case', () => {
    expect(checkUrl('https://WWW.fakegym.test:8443/cancel?x=1', allowlist)).toEqual({ allowed: true });
  });

  it('allows the documents a page reaches without going anywhere', () => {
    for (const url of [
      'about:blank',
      'about:srcdoc',
      'data:text/html,<p>x</p>',
      'blob:https://fakegym.test/1234',
    ]) {
      expect(checkUrl(url, allowlist)).toEqual({ allowed: true });
    }
  });

  it('refuses an off-list host and names it', () => {
    expect(checkUrl('http://localhost:4303/login', allowlist)).toEqual({
      allowed: false,
      reason: 'host',
      host: 'localhost',
    });
  });

  it('refuses a scheme that is not the web, and a string that is not a URL', () => {
    expect(checkUrl('file:///etc/passwd', allowlist)).toEqual({
      allowed: false,
      reason: 'scheme',
      host: undefined,
    });
    expect(checkUrl('not a url', allowlist)).toEqual({
      allowed: false,
      reason: 'unparseable',
      host: undefined,
    });
  });
});
