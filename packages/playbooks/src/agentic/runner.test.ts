import { describe, expect, it } from 'vitest';

import { agenticStart, redactSecrets } from './runner.js';

describe('agenticStart', () => {
  it('takes an absolute http or https URL from the input and keeps the input beside it', () => {
    const start = agenticStart({ url: 'https://gym.example/account?tab=plan', goal: 'cancel' });
    expect(start.ok).toBe(true);
    if (start.ok) {
      expect(start.url.href).toBe('https://gym.example/account?tab=plan');
      expect(start.input).toEqual({ url: 'https://gym.example/account?tab=plan', goal: 'cancel' });
    }
  });

  it.each([
    ['no input', undefined],
    ['a list', ['https://gym.example']],
    ['no url', { site: 'gym' }],
    ['a relative url', { url: '/account' }],
    ['a url of another scheme', { url: 'file:///etc/passwd' }],
    ['a url that is not one', { url: 'not a url' }],
  ])('refuses %s in a sentence that says what is needed', (_named, input) => {
    expect(agenticStart(input)).toEqual({
      ok: false,
      reason: 'agentic mode needs input.url: an absolute http(s) URL to start at',
    });
  });
});

describe('redactSecrets', () => {
  it('strikes every secret out of every string, however deep, and leaves everything else as it was', () => {
    const payload = {
      name: 'tool:type',
      outcome: 'ok',
      detail: {
        input: { ref: 'e4', text: 'open-sesame' },
        result: { kind: 'field', value: 'open-sesame' },
        nested: [1, 'x open-sesame y', null],
      },
    };
    expect(redactSecrets(payload, ['open-sesame'])).toEqual({
      name: 'tool:type',
      outcome: 'ok',
      detail: {
        input: { ref: 'e4', text: '[redacted]' },
        result: { kind: 'field', value: '[redacted]' },
        nested: [1, 'x [redacted] y', null],
      },
    });
  });

  it('changes nothing when there is no secret, and ignores an empty one rather than redacting every gap', () => {
    const payload = { name: 'tool:read', detail: 'fine' };
    expect(redactSecrets(payload, [])).toBe(payload);
    expect(redactSecrets(payload, [''])).toBe(payload);
  });
});
