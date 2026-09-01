import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ConfigError } from '../config.js';
import {
  API_PUBLIC_URL_VARIABLE,
  DASHBOARD_BASE_URL_VARIABLE,
  DEFAULT_DASHBOARD_BASE_URL,
  SESSION_COOKIE_DOMAIN_VARIABLE,
  SESSION_COOKIE_NAME,
  SESSION_SECRET_VARIABLE,
  SESSION_TTL_MS,
  clearedSessionCookieHeader,
  loadAuthConfig,
  mintSessionCookie,
  readCookie,
  sessionCookieHeader,
  signSession,
  verifySessionToken,
  type AuthConfigSource,
} from './session.js';

/**
 * What a session is worth, decided in isolation.
 *
 * `auth.integration.test.ts` proves the flow over HTTP; this covers the answers
 * that flow never asks for - the refusals that all have to look identical, and
 * the configuration a production boot depends on and a workstation must not.
 */

const SECRET = 'the-secret-this-suite-configured';
const USER = '11111111-1111-4111-8111-111111111111';

const LOCAL: AuthConfigSource = {
  host: '127.0.0.1',
  port: 3000,
  runtimeEnvironment: 'development',
};
const PRODUCTION: AuthConfigSource = { host: '0.0.0.0', port: 8080, runtimeEnvironment: 'production' };

const soon = (): Date => new Date(Date.now() + 60_000);

/**
 * A token whose signature is genuine and whose claims are whatever was asked
 * for. Needed because a forged payload carrying somebody else's signature is
 * refused for the signature, which would leave every claim check below passing
 * for the wrong reason.
 */
function signClaims(claims: string, secret = SECRET): string {
  const payload = Buffer.from(claims, 'utf8').toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

describe('loadAuthConfig', () => {
  it('refuses to boot a production server with no secret', () => {
    // Every deploy would otherwise sign every user out, and two instances
    // behind a load balancer would each reject the other's cookies.
    expect(() => loadAuthConfig({}, PRODUCTION)).toThrow(ConfigError);
    expect(() => loadAuthConfig({ [SESSION_SECRET_VARIABLE]: '  ' }, PRODUCTION)).toThrow(
      ConfigError,
    );
    expect(() => loadAuthConfig({}, PRODUCTION)).toThrow(SESSION_SECRET_VARIABLE);
  });

  it('invents one anywhere else, differently every time', () => {
    const first = loadAuthConfig({}, LOCAL);
    const second = loadAuthConfig({}, LOCAL);

    // Not a convenience: a workstation that had to invent a secret before it
    // could run the server would have every developer paste the same one into
    // the same file, and a shared development secret is worth less than none.
    expect(first.sessionSecret).toHaveLength(64);
    expect(first.sessionSecret).not.toBe(second.sessionSecret);
    // The honest consequence is that restarting signs everybody out.
    expect(verifySessionToken(signSession(USER, first.sessionSecret, soon()), second.sessionSecret)).toBeUndefined();
  });

  it('uses a configured secret verbatim, trimmed', () => {
    const config = loadAuthConfig({ [SESSION_SECRET_VARIABLE]: '  shared  ' }, PRODUCTION);

    expect(config.sessionSecret).toBe('shared');
  });

  it('builds a link origin a browser can actually follow', () => {
    // `0.0.0.0` is what a server binds, never an address anyone can click, so a
    // link built from it would arrive unusable.
    expect(loadAuthConfig({ [SESSION_SECRET_VARIABLE]: 's' }, PRODUCTION).apiPublicUrl).toBe(
      'http://127.0.0.1:8080',
    );
    expect(
      loadAuthConfig({ [SESSION_SECRET_VARIABLE]: 's' }, { ...PRODUCTION, host: '::' })
        .apiPublicUrl,
    ).toBe('http://127.0.0.1:8080');
    expect(loadAuthConfig({}, LOCAL).apiPublicUrl).toBe('http://127.0.0.1:3000');
  });

  it('prefers the configured origins and drops their trailing slashes', () => {
    const config = loadAuthConfig(
      {
        [API_PUBLIC_URL_VARIABLE]: 'https://api.example.com//',
        [DASHBOARD_BASE_URL_VARIABLE]: 'https://app.example.com/',
      },
      LOCAL,
    );

    // Dropped here so every path built from them can be written with a leading
    // one and mean the same thing.
    expect(config.apiPublicUrl).toBe('https://api.example.com');
    expect(config.dashboardBaseUrl).toBe('https://app.example.com');
  });

  it('sends a consumed link to the local dashboard when nothing says otherwise', () => {
    expect(loadAuthConfig({}, LOCAL).dashboardBaseUrl).toBe(DEFAULT_DASHBOARD_BASE_URL);
  });

  it('leaves the cookie host-only unless a shared domain was named', () => {
    // Host-only is what loopback and single-host deployments want: same host,
    // different ports, one cookie.
    expect(loadAuthConfig({}, LOCAL).cookieDomain).toBeUndefined();
    expect(loadAuthConfig({ [SESSION_COOKIE_DOMAIN_VARIABLE]: ' ' }, LOCAL).cookieDomain).toBeUndefined();
    expect(
      loadAuthConfig({ [SESSION_COOKIE_DOMAIN_VARIABLE]: '.example.com' }, LOCAL).cookieDomain,
    ).toBe('.example.com');
  });

  it('marks the cookie Secure in production and nowhere else', () => {
    // `Secure` on plain-http loopback would make the cookie undeliverable, and
    // its absence in production would make it interceptable.
    expect(loadAuthConfig({ [SESSION_SECRET_VARIABLE]: 's' }, PRODUCTION).cookieSecure).toBe(true);
    expect(loadAuthConfig({}, LOCAL).cookieSecure).toBe(false);
  });
});

describe('a session token', () => {
  it('speaks for the user it was signed for', () => {
    expect(verifySessionToken(signSession(USER, SECRET, soon()), SECRET)).toBe(USER);
  });

  it('refuses everything that is not one, identically', () => {
    const valid = signSession(USER, SECRET, soon());
    const [payload, signature] = valid.split('.');

    for (const [what, token] of [
      ['nothing at all', undefined],
      ['empty', ''],
      ['no separator', 'nonsense'],
      ['an empty payload', `.${String(signature)}`],
      ['another secret', signSession(USER, 'a different secret', soon())],
      ['an edited payload', `${String(payload)}x.${String(signature)}`],
      ['an edited signature', `${String(payload)}.${String(signature)}x`],
      ['a truncated signature', `${String(payload)}.${String(signature).slice(0, -1)}`],
      ['no signature', `${String(payload)}.`],
      // Signed properly, so what is refused is the payload rather than the key.
      ['a genuinely signed payload that is not JSON', signClaims('not json')],
    ] as const) {
      // The same `undefined` for all of them. A caller that could tell them
      // apart would be handing an attacker a way to ask which guess was
      // closest.
      expect(verifySessionToken(token, SECRET), what).toBeUndefined();
    }
  });

  it('refuses claims that are the wrong shape, however well signed', () => {
    for (const claims of [
      'null',
      '"a string"',
      '{}',
      '{"uid":"","exp":1}',
      '{"uid":"u"}',
      '{"uid":1,"exp":1}',
      '{"uid":"u","exp":"soon"}',
    ]) {
      // Signed with the real key, so what is being refused is the shape rather
      // than the signature. Anything that reached the claim checks holding a
      // valid signature came from this server, and it still has to be the shape
      // this server writes.
      expect(verifySessionToken(signClaims(claims), SECRET), claims).toBeUndefined();
    }
  });

  it('stops speaking for anybody once it has expired', () => {
    const token = signSession(USER, SECRET, new Date(Date.now() - 1));

    expect(verifySessionToken(token, SECRET)).toBeUndefined();
    // And the clock is a parameter, so this is provable without waiting.
    const later = signSession(USER, SECRET, new Date(Date.now() + 1000));
    expect(verifySessionToken(later, SECRET, new Date(Date.now() + 5000))).toBeUndefined();
    expect(verifySessionToken(later, SECRET, new Date())).toBe(USER);
  });
});

describe('the session cookie', () => {
  it('is scoped and shielded the way the guard needs', () => {
    const header = sessionCookieHeader('value', { maxAgeSeconds: 3600 });

    expect(header).toContain(`${SESSION_COOKIE_NAME}=value`);
    expect(header).toContain('Path=/');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Max-Age=3600');
    expect(header).not.toContain('Domain=');
    expect(header).not.toContain('Secure');
  });

  it('carries a domain and Secure only when it was told to', () => {
    const header = sessionCookieHeader('value', {
      domain: '.example.com',
      secure: true,
      maxAgeSeconds: 60,
    });

    expect(header).toContain('Domain=.example.com');
    expect(header).toContain('Secure');
  });

  it('is emptied as well as expired when it is cleared', () => {
    const header = clearedSessionCookieHeader({});

    // A client that ignores `Max-Age` is still left holding nothing that
    // verifies.
    expect(header.startsWith(`${SESSION_COOKIE_NAME}=;`)).toBe(true);
    expect(header).toContain('Max-Age=0');
  });

  it('mints a request header a test can present as somebody', () => {
    const cookie = mintSessionCookie(USER, SECRET);
    const token = readCookie(cookie, SESSION_COOKIE_NAME);

    expect(verifySessionToken(token, SECRET)).toBe(USER);
    // The default lifetime is hours, not weeks: ending a session means taking
    // the cookie away rather than deleting a row.
    expect(verifySessionToken(token, SECRET, new Date(Date.now() + SESSION_TTL_MS + 1000))).toBeUndefined();
    expect(verifySessionToken(readCookie(mintSessionCookie(USER, SECRET, -1), SESSION_COOKIE_NAME), SECRET)).toBeUndefined();
  });
});

describe('readCookie', () => {
  it('finds one cookie among others, however it was spaced', () => {
    expect(readCookie('a=1; cos_session=abc ; b=2', SESSION_COOKIE_NAME)).toBe('abc');
    expect(readCookie(`${SESSION_COOKIE_NAME}=only`, SESSION_COOKIE_NAME)).toBe('only');
  });

  it('answers undefined for anything it cannot find', () => {
    expect(readCookie(undefined, SESSION_COOKIE_NAME)).toBeUndefined();
    expect(readCookie('a=1; b=2', SESSION_COOKIE_NAME)).toBeUndefined();
    // A bare token with no `=` is not a cookie and must not crash the parse.
    expect(readCookie('flag; a=1', SESSION_COOKIE_NAME)).toBeUndefined();
    // A name that merely ends with the one being looked for is a different
    // cookie, and matching it would be a way to smuggle a session in.
    expect(readCookie(`not_${SESSION_COOKIE_NAME}=abc`, SESSION_COOKIE_NAME)).toBeUndefined();
  });
});
