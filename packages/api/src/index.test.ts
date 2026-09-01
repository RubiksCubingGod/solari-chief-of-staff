import { describe, expect, it } from 'vitest';

import {
  SESSION_COOKIE_NAME,
  ERROR_CODES,
  HttpError,
  createApp,
  declaredErrorCode,
  mintSessionCookie,
  verifySessionToken,
  errorEnvelope,
  isCronExpression,
  loadConfig,
  violationDetails,
} from './index.js';

describe('@chief-of-staff/api', () => {
  it('exposes the app factory, the config loader, and the error envelope', () => {
    expect(typeof createApp).toBe('function');
    expect(typeof loadConfig).toBe('function');
    expect(errorEnvelope('not_found', 'nope')).toEqual({
      error: { code: 'not_found', message: 'nope' },
    });
  });

  it('omits details from the envelope rather than sending an empty list', () => {
    expect(errorEnvelope('bad_request', 'nope', [{ path: '/kind', message: 'is invalid' }])).toEqual(
      { error: { code: 'bad_request', message: 'nope', details: [{ path: '/kind', message: 'is invalid' }] } },
    );
    expect(Object.keys(errorEnvelope('bad_request', 'nope').error)).toEqual(['code', 'message']);
  });

  it('names a violation Ajv left unexplained rather than sending undefined', () => {
    expect(violationDetails([{ instancePath: '/kind', message: 'must be a string' }])).toEqual([
      { path: '/kind', message: 'must be a string' },
    ]);
    expect(violationDetails([{ instancePath: '/url' }])).toEqual([
      { path: '/url', message: 'is invalid' },
    ]);
  });

  it('keeps every error code distinct', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it('exposes what a client of this server has to agree with it about', () => {
    // The cookie name, because a dashboard that guessed it would guard nothing,
    // and the minting helper, because every package whose integration suite
    // drives a real server needs one line to act as somebody.
    expect(SESSION_COOKIE_NAME).toBe('cos_session');
    const cookie = mintSessionCookie('a5f2f3c8-0b3c-4a0e-9f1e-6a7c0b9d2e11', 'a-test-secret');
    expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
    expect(
      verifySessionToken(cookie.slice(SESSION_COOKIE_NAME.length + 1), 'a-test-secret'),
    ).toBe('a5f2f3c8-0b3c-4a0e-9f1e-6a7c0b9d2e11');
    // Signed with one secret, worthless under another.
    expect(
      verifySessionToken(cookie.slice(SESSION_COOKIE_NAME.length + 1), 'another-secret'),
    ).toBeUndefined();
    expect(isCronExpression('0 * * * *')).toBe(true);
  });

  it('recognises only the codes it declares', () => {
    expect(declaredErrorCode('not_found')).toBe('not_found');
    expect(declaredErrorCode('FST_ERR_CTP_EMPTY_JSON_BODY')).toBeUndefined();
    expect(declaredErrorCode(undefined)).toBeUndefined();
    expect(new HttpError(404, 'not_found', 'gone')).toMatchObject({
      statusCode: 404,
      code: 'not_found',
      message: 'gone',
      name: 'HttpError',
    });
  });
});
