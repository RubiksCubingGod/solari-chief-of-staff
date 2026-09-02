import { describe, expect, it } from 'vitest';

import {
  CODE_QUESTION,
  CODE_RETRY_QUESTION,
  codeToTry,
  describeAnswer,
  fakegymCancellation,
  parseSiteAnswer,
} from './cancellation.js';

describe('parseSiteAnswer', () => {
  it('reads a status, with the next page when the site names one', () => {
    expect(parseSiteAnswer('{"status":"active","next":"/cancel/step-2"}')).toEqual({
      kind: 'status',
      status: 'active',
      next: '/cancel/step-2',
    });
    expect(parseSiteAnswer('{"status":"cancelled"}')).toEqual({ kind: 'status', status: 'cancelled' });
  });

  it('reads a refusal by its code, with an empty message when the site gives none', () => {
    expect(parseSiteAnswer('{"code":"wrong-code","message":"that confirmation code is not correct"}')).toEqual({
      kind: 'refusal',
      code: 'wrong-code',
      message: 'that confirmation code is not correct',
    });
    expect(parseSiteAnswer('{"code":"unauthenticated"}')).toEqual({
      kind: 'refusal',
      code: 'unauthenticated',
      message: '',
    });
  });

  it.each([
    ['a page', '<h1>Sign in</h1>'],
    ['a JSON scalar', '42'],
    ['a JSON array', '["status"]'],
    ['a JSON object with neither field', '{"ok":true}'],
    ['a status that is not a string', '{"status":7}'],
  ])('keeps %s as text', (_label, text) => {
    expect(parseSiteAnswer(text)).toEqual({ kind: 'other', text });
  });
});

describe('describeAnswer', () => {
  it('names a refusal by its code', () => {
    expect(
      describeAnswer('the credentials', { kind: 'refusal', code: 'bad-credentials', message: 'no such member' }),
    ).toBe('fakegym refused the credentials (bad-credentials)');
  });

  it('names a status the step did not expect', () => {
    expect(describeAnswer('the confirmation code', { kind: 'status', status: 'retained' })).toBe(
      'fakegym answered the confirmation code with status retained',
    );
  });

  it('excerpts anything else onto one line', () => {
    expect(describeAnswer('the member page', { kind: 'other', text: '  Sign in\n\n  Email  ' })).toBe(
      'fakegym answered the member page with something else: Sign in Email',
    );
    expect(describeAnswer('it', { kind: 'other', text: 'x'.repeat(100) })).toBe(
      `fakegym answered it with something else: ${'x'.repeat(77)}...`,
    );
  });
});

describe('codeToTry', () => {
  const answers = (record: Record<string, string>) => (question: string) => record[question];

  it('is nothing until the person has answered', () => {
    expect(codeToTry(() => undefined)).toBeUndefined();
  });

  it('is the first reply, trimmed, before any retry', () => {
    expect(codeToTry(answers({ [CODE_QUESTION]: ' GYM-000001 ' }))).toEqual({ code: 'GYM-000001', retried: false });
  });

  it('prefers the reply to the retry question, because the first was refused', () => {
    expect(codeToTry(answers({ [CODE_QUESTION]: 'GYM-000001', [CODE_RETRY_QUESTION]: 'GYM-000002' }))).toEqual({
      code: 'GYM-000002',
      retried: true,
    });
  });
});

describe('fakegymCancellation', () => {
  it('is the cancel playbook for fakegym at the fixture origin, in four steps', () => {
    const playbook = fakegymCancellation({ origin: 'http://127.0.0.1:4303/' });
    expect(playbook).toMatchObject({
      id: 'fakegym.cancel',
      site: 'fakegym',
      action: 'cancel',
      origin: 'http://127.0.0.1:4303',
      siteDomain: '127.0.0.1:4303',
      allowlist: ['127.0.0.1'],
    });
    expect(playbook.steps.map((step) => step.name)).toEqual([
      'login',
      'retention',
      'are-you-sure',
      'confirmation-code',
    ]);
  });

  it('takes an id of its own', () => {
    expect(fakegymCancellation({ origin: 'http://127.0.0.1:4303', id: 'gym-local' }).id).toBe('gym-local');
  });

  it('refuses an origin that is not a URL, in the words every playbook uses', () => {
    expect(() => fakegymCancellation({ origin: 'the gym' })).toThrow(
      'playbook fakegym.cancel: origin the gym is not a URL',
    );
  });
});
