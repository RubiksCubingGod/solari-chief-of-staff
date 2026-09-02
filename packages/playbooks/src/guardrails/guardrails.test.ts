import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  guardedRequest,
  judgeRequest,
  paymentConfirmations,
  paymentFingerprint,
  paymentQuestion,
  stopOutcome,
  type AllowlistViolation,
  type GuardrailPolicy,
  type PaymentGate,
  type RequestFacts,
} from './guardrails.js';
import type { PageSnapshot } from './payment-detector.js';

const policy: GuardrailPolicy = { allowlist: ['fakegym.test'] };

function facts(overrides: Partial<RequestFacts> = {}): RequestFacts {
  return {
    url: 'https://www.fakegym.test/member',
    method: 'GET',
    topLevelNavigation: true,
    redirectedFrom: undefined,
    popup: false,
    pageUrl: 'https://www.fakegym.test/',
    pageTitle: 'Fakegym',
    contentType: undefined,
    body: undefined,
    page: undefined,
    ...overrides,
  };
}

const CARD_POST: Partial<RequestFacts> = {
  url: 'https://www.fakegym.test/order',
  method: 'POST',
  contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
  body: 'cardnumber=4242424242424242&exp=12%2F34&cvc=123',
};

function gateOf(overrides: Partial<RequestFacts>, policyUsed: GuardrailPolicy = policy): PaymentGate {
  const judgement = judgeRequest(policyUsed, facts(overrides));
  if (judgement.action !== 'stop' || judgement.stop.kind !== 'payment') {
    throw new Error('expected a payment gate');
  }
  return judgement.stop;
}

describe('judgeRequest: the allowlist', () => {
  it('lets a navigation inside the lane through', () => {
    expect(judgeRequest(policy, facts())).toEqual({ action: 'continue' });
  });

  it('stops a top-level navigation outside it, and says how the page got there', () => {
    expect(judgeRequest(policy, facts({ url: 'https://evil.test/x' }))).toEqual({
      action: 'stop',
      stop: {
        kind: 'allowlist',
        attemptedUrl: 'https://evil.test/x',
        via: 'navigation',
        redirectedFrom: undefined,
        from: 'https://www.fakegym.test/',
        reason: 'host',
      },
    });
    expect(
      judgeRequest(
        policy,
        facts({ url: 'https://evil.test/x', redirectedFrom: 'https://www.fakegym.test/leave' }),
      ),
    ).toMatchObject({ stop: { via: 'redirect', redirectedFrom: 'https://www.fakegym.test/leave' } });
    expect(
      judgeRequest(policy, facts({ url: 'https://evil.test/x', popup: true, pageUrl: 'about:blank' })),
    ).toMatchObject({ stop: { via: 'popup', from: 'about:blank' } });
  });

  it('leaves subresources and embedded frames alone: the lane is where the top-level document goes', () => {
    expect(
      judgeRequest(policy, facts({ url: 'https://cdn.evil.test/app.js', topLevelNavigation: false })),
    ).toEqual({ action: 'continue' });
  });

  it('refuses a scheme that is not the web', () => {
    expect(judgeRequest(policy, facts({ url: 'file:///etc/hosts' }))).toMatchObject({
      stop: { kind: 'allowlist', reason: 'scheme' },
    });
  });

  it('checks the lane before the gate: a payment posted outside it is a violation', () => {
    expect(judgeRequest(policy, facts({ ...CARD_POST, url: 'https://evil.test/order' }))).toMatchObject({
      stop: { kind: 'allowlist', attemptedUrl: 'https://evil.test/order' },
    });
  });
});

describe('judgeRequest: the payment gate', () => {
  it('stops a submission carrying card data, and fingerprints it', () => {
    const gate = gateOf(CARD_POST);
    expect(gate).toMatchObject({
      url: 'https://www.fakegym.test/order',
      method: 'POST',
      fieldNames: ['cardnumber', 'exp', 'cvc'],
      page: { url: 'https://www.fakegym.test/', title: 'Fakegym' },
    });
    expect(gate.evidence).toEqual(expect.arrayContaining([{ signal: 'card_value', where: 'cardnumber' }]));
    expect(gate.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('lets exactly the confirmed submission through, and nothing else', () => {
    const gate = gateOf(CARD_POST);
    const confirmed: GuardrailPolicy = { ...policy, confirmedPayments: [gate.fingerprint] };
    expect(judgeRequest(confirmed, facts(CARD_POST))).toEqual({ action: 'continue' });
    expect(
      judgeRequest(confirmed, facts({ ...CARD_POST, url: 'https://www.fakegym.test/order-again' })).action,
    ).toBe('stop');
    expect(
      judgeRequest(confirmed, facts({ ...CARD_POST, body: `${CARD_POST.body ?? ''}&tip=1` })).action,
    ).toBe('stop');
  });

  it('fingerprints by target and field names, not by values, order, or query', () => {
    const one = paymentFingerprint({
      url: 'https://s.test/pay?x=1',
      method: 'POST',
      fields: [
        { name: 'b', value: '1' },
        { name: 'a', value: '2' },
      ],
    });
    const two = paymentFingerprint({
      url: 'https://s.test/pay?x=2',
      method: 'POST',
      fields: [
        { name: 'a', value: '9' },
        { name: 'b', value: '8' },
      ],
    });
    expect(one).toBe(two);
    expect(paymentFingerprint({ url: 'https://s.test/pay2', method: 'POST', fields: [] })).not.toBe(one);
    expect(paymentFingerprint({ url: 'not a url', method: 'POST', fields: [] })).toMatch(/^[0-9a-f]{16}$/);
  });

  it('stops a tokenised submission when the page it came from is a checkout', () => {
    const checkout: PageSnapshot = {
      url: 'https://www.fakegym.test/checkout',
      title: 'Checkout',
      forms: [
        {
          action: '/order',
          method: 'post',
          fields: [{ name: 'card', type: 'text', autocomplete: 'cc-number', id: '', label: 'Card number', placeholder: '' }],
          submitLabels: ['Pay now'],
        },
      ],
      frameHosts: [],
      text: 'Order total $49.00',
    };
    const gate = gateOf({ ...CARD_POST, body: 'payment_method=pm_123', page: checkout });
    expect(gate.fieldNames).toEqual(['payment_method']);
    expect(gate.evidence).toEqual(expect.arrayContaining([{ signal: 'payment_verb', where: 'Pay now' }]));
  });

  it('lets an ordinary submission through, and never looks at a read', () => {
    expect(
      judgeRequest(policy, facts({ ...CARD_POST, body: 'email=a%40b.test&password=hunter2' })),
    ).toEqual({ action: 'continue' });
    expect(judgeRequest(policy, facts({ ...CARD_POST, method: 'GET', topLevelNavigation: false }))).toEqual({
      action: 'continue',
    });
  });

  it('has no switch: a policy claiming the gate is off is still gated', () => {
    const forged = { ...policy, paymentGate: false, allowPayments: true, skipGuardrails: true } as GuardrailPolicy;
    expect(judgeRequest(forged, facts(CARD_POST)).action).toBe('stop');
    expectTypeOf<keyof GuardrailPolicy>().toEqualTypeOf<'allowlist' | 'confirmedPayments'>();
  });
});

describe('paymentQuestion and paymentConfirmations', () => {
  const gate = gateOf(CARD_POST);
  const question = paymentQuestion(gate);
  const answer = (reply: string, text = question) => ({
    questionId: 'q1',
    question: text,
    reply,
    answeredAt: '2026-09-02T00:00:00.000Z',
  });

  it('tells the person where, what, and why, and ends with the tag', () => {
    expect(question).toContain('Page: Fakegym (https://www.fakegym.test/)');
    expect(question).toContain('Submission: POST https://www.fakegym.test/order with cardnumber, exp, cvc');
    expect(question).toContain('card value "cardnumber"');
    expect(question.endsWith(`[payment-gate ${gate.fingerprint}]`)).toBe(true);
    expect(paymentQuestion({ ...gate, fieldNames: [], page: { url: 'x', title: '' } })).toContain(
      'Page: (untitled) (x)\nSubmission: POST https://www.fakegym.test/order\n',
    );
  });

  it('reads a confirmation from an affirmative reply to a tagged question, and from nothing else', () => {
    for (const reply of ['confirm', 'Confirmed!', 'yes', 'OK', 'approve', 'go ahead.']) {
      expect(paymentConfirmations([answer(reply)])).toEqual([gate.fingerprint]);
    }
    for (const reply of ['no', 'what is this?', 'confirm later', 'yes but only $10']) {
      expect(paymentConfirmations([answer(reply)])).toEqual([]);
    }
    expect(paymentConfirmations([answer('confirm', 'Which plan?')])).toEqual([]);
    expect(paymentConfirmations([])).toEqual([]);
  });
});

describe('stopOutcome', () => {
  it('fails the mission by violation on an allowlist stop, with the attempt in the detail', () => {
    const judgement = judgeRequest(policy, facts({ url: 'https://evil.test/x' }));
    if (judgement.action !== 'stop') throw new Error('expected a stop');
    expect(stopOutcome(judgement.stop)).toEqual({
      kind: 'failed',
      cause: 'violation',
      reason: "navigation to https://evil.test/x is outside the task's allowlist",
      detail: judgement.stop,
    });
  });

  it('fails the mission by violation on a request-context stop, and says the request would have bypassed the guard', () => {
    const stop: AllowlistViolation = {
      kind: 'allowlist',
      attemptedUrl: 'https://evil.test/x',
      via: 'request-context',
      redirectedFrom: undefined,
      from: 'https://fakegym.test/member',
      reason: 'unguarded',
    };
    expect(stopOutcome(stop)).toEqual({
      kind: 'failed',
      cause: 'violation',
      reason: "request to https://evil.test/x through the browser's request context would bypass the guard",
      detail: stop,
    });
  });

  it('parks the mission on the question on a payment stop', () => {
    const gate = gateOf(CARD_POST);
    expect(stopOutcome(gate)).toEqual({ kind: 'ask', question: paymentQuestion(gate) });
  });
});

describe('guardedRequest', () => {
  it('always asks for a recording, whatever was asked', () => {
    expect(guardedRequest()).toEqual({ recording: true });
    expect(guardedRequest({ recording: false, stealth: true })).toEqual({ stealth: true, recording: true });
  });
});
