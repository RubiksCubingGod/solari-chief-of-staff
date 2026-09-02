import { describe, expect, it } from 'vitest';

import {
  describePaymentEvidence,
  detectPaymentPage,
  detectPaymentSubmission,
  parseSubmission,
  type FieldSnapshot,
  type FormSnapshot,
  type PageSnapshot,
  type PaymentSignal,
  type SubmissionSnapshot,
} from './payment-detector.js';

function field(name: string, extras: Partial<FieldSnapshot> = {}): FieldSnapshot {
  return { name, type: 'text', autocomplete: '', id: '', label: '', placeholder: '', ...extras };
}

function form(
  fields: readonly FieldSnapshot[],
  submitLabels: readonly string[],
  method = 'post',
): FormSnapshot {
  return { action: '', method, fields, submitLabels };
}

function page(overrides: Partial<PageSnapshot>): PageSnapshot {
  return { url: 'https://www.example.test/', title: '', forms: [], frameHosts: [], text: '', ...overrides };
}

interface RecordedPage {
  readonly name: string;
  readonly snapshot: PageSnapshot;
  /** Signals the verdict must cite. */
  readonly signals: readonly PaymentSignal[];
}

/** Pages recorded from the shapes checkouts take, in the terms the snapshot script reports them. */
const PAYMENT_PAGES: readonly RecordedPage[] = [
  {
    name: 'a hosted Stripe Checkout with the card form on the page',
    snapshot: page({
      url: 'https://checkout.stripe.com/c/pay/cs_test_a1B2c3',
      title: 'Fakegym Pro',
      forms: [
        form(
          [
            field('email', { type: 'email', autocomplete: 'email', label: 'Email' }),
            field('cardNumber', { autocomplete: 'cc-number', label: 'Card number', placeholder: '1234 1234 1234 1234' }),
            field('cardExpiry', { autocomplete: 'cc-exp', label: 'Expiration', placeholder: 'MM / YY' }),
            field('cardCvc', { autocomplete: 'cc-csc', label: 'CVC' }),
            field('billingName', { autocomplete: 'cc-name', label: 'Name on card' }),
          ],
          ['Pay $49.00'],
        ),
      ],
      text: 'Fakegym Pro plan $49.00 per month Card information Name on card Country or region Pay $49.00',
    }),
    signals: ['card_field', 'payment_verb'],
  },
  {
    name: 'a Shopify checkout whose card fields live in a processor frame the detector does not know',
    snapshot: page({
      url: 'https://shop.example.test/checkouts/cn/Z2NwLXVzLWVhc3Qx',
      title: 'Checkout - Example Shop',
      forms: [
        form(
          [
            field('checkout[shipping_address][first_name]', { label: 'First name' }),
            field('checkout[shipping_address][address1]', { autocomplete: 'shipping address-line1', label: 'Address' }),
          ],
          ['Pay now'],
        ),
      ],
      frameHosts: ['checkout.shopifycs.com'],
      text: 'Order summary Subtotal $80.00 Shipping $5.00 Total $85.00 Payment All transactions are secure and encrypted Credit card Pay now',
    }),
    signals: ['payment_verb', 'checkout_marker'],
  },
  {
    name: "a merchant page with Stripe Elements: the card is in Stripe's frame, the button is tame",
    snapshot: page({
      url: 'https://app.example.test/billing',
      title: 'Billing',
      forms: [form([field('email', { type: 'email' }), field('name', { label: 'Full name' })], ['Subscribe'])],
      frameHosts: ['js.stripe.com', 'm.stripe.network'],
      text: 'Start your plan $9 a month Subscribe',
    }),
    signals: ['processor_frame'],
  },
  {
    name: 'a direct-debit mandate: no card, but a bank account',
    snapshot: page({
      url: 'https://www.example.test/join/payment',
      forms: [form([field('account_holder', { label: 'Account holder' }), field('iban', { label: 'IBAN' })], ['Start membership'])],
      text: 'Set up your direct debit',
    }),
    signals: ['card_field', 'payment_verb'],
  },
  {
    name: 'an old card form with no autocomplete tokens, named the way they were named',
    snapshot: page({
      url: 'https://www.example.test/cart/step3.php',
      forms: [
        form(
          [
            field('cc_number', { label: 'Credit card number' }),
            field('cc_exp_month', { type: 'select' }),
            field('cc_exp_year', { type: 'select' }),
            field('cvv2', { label: 'Security code' }),
          ],
          ['Complete purchase'],
        ),
      ],
      text: 'Billing information',
    }),
    signals: ['card_field', 'security_code', 'payment_verb'],
  },
  {
    name: 'an invoice with nothing on the page but a pay button carrying an amount',
    snapshot: page({
      url: 'https://www.example.test/invoices/1042',
      forms: [form([field('invoice_id', { type: 'hidden' })], ['Pay $120.00'])],
      text: 'Invoice #1042 is due',
    }),
    signals: ['payment_verb', 'checkout_marker'],
  },
];

/** Pages that are not payments, including every step of the fakegym cancellation. */
const OTHER_PAGES: readonly { readonly name: string; readonly snapshot: PageSnapshot }[] = [
  {
    name: 'the fakegym login',
    snapshot: page({
      url: 'http://127.0.0.1:4303/login',
      title: 'Fakegym - Sign in',
      forms: [form([field('email', { type: 'email' }), field('password', { type: 'password' })], ['Sign in'])],
      text: 'Sign in Email Password Sign in',
    }),
  },
  {
    name: 'the fakegym retention step',
    snapshot: page({
      url: 'http://127.0.0.1:4303/cancel/retention',
      forms: [form([], ['Keep my membership', 'Continue cancelling'])],
      text: 'Before you go Stay with us and get two months at half price',
    }),
  },
  {
    name: 'the fakegym confirmation code',
    snapshot: page({
      url: 'http://127.0.0.1:4303/cancel/confirm',
      forms: [form([field('code', { label: 'Confirmation code' })], ['Cancel my membership'])],
      text: 'Enter your confirmation code We emailed a six-digit code to the address on file',
    }),
  },
  {
    name: 'a newsletter signup',
    snapshot: page({
      forms: [form([field('email', { type: 'email' })], ['Subscribe'])],
      text: 'Subscribe to our newsletter',
    }),
  },
  {
    name: 'a search box under shop chrome that mentions the checkout',
    snapshot: page({
      forms: [form([field('q', { placeholder: 'Search products' })], ['Search'], 'get')],
      text: 'Cart (2) Checkout Search products',
    }),
  },
  {
    name: 'a cart page: an order summary and a button to the checkout, but no money moving yet',
    snapshot: page({
      url: 'https://shop.example.test/cart',
      forms: [form([field('quantity', { type: 'number' })], ['Update cart']), form([], ['Checkout'])],
      text: 'Order summary Subtotal $80.00 Checkout',
    }),
  },
  {
    name: 'a travel document form with an expiry date',
    snapshot: page({
      forms: [form([field('passport_number'), field('expiry_date', { label: 'Passport expiry date' })], ['Save'])],
      text: 'Travel documents',
    }),
  },
  {
    name: 'an address book entry',
    snapshot: page({
      forms: [
        form(
          [field('address1', { autocomplete: 'address-line1' }), field('postal_code', { autocomplete: 'postal-code' })],
          ['Save address'],
        ),
      ],
    }),
  },
];

describe('detectPaymentPage', () => {
  it.each(PAYMENT_PAGES)('sees a payment in $name', ({ snapshot, signals }) => {
    const verdict = detectPaymentPage(snapshot);
    expect(verdict.payment).toBe(true);
    const cited = verdict.evidence.map((item) => item.signal);
    for (const signal of signals) expect(cited).toContain(signal);
  });

  it.each(OTHER_PAGES)('sees no payment in $name', ({ snapshot }) => {
    expect(detectPaymentPage(snapshot).payment).toBe(false);
  });

  it('names what it matched, so the question can say why', () => {
    const verdict = detectPaymentPage(
      page({
        forms: [form([field('', { id: 'card', autocomplete: 'CC-Number' })], ['Pay now'])],
        frameHosts: ['JS.STRIPE.COM'],
        text: 'Total due $12.00',
      }),
    );
    expect(verdict.evidence).toEqual([
      { signal: 'card_field', where: 'card (autocomplete cc-number)' },
      { signal: 'payment_verb', where: 'Pay now' },
      { signal: 'processor_frame', where: 'JS.STRIPE.COM' },
      { signal: 'checkout_marker', where: 'Total due' },
    ]);
    expect(describePaymentEvidence(verdict.evidence)).toBe(
      'card field "card (autocomplete cc-number)"; payment verb "Pay now"; processor frame "JS.STRIPE.COM"; checkout marker "Total due"',
    );
  });

  it('reads the checkout marker from the URL when the text has none', () => {
    const verdict = detectPaymentPage(
      page({ url: 'https://www.example.test/checkout/', forms: [form([], ['Buy now'])] }),
    );
    expect(verdict.payment).toBe(true);
    expect(verdict.evidence).toContainEqual({ signal: 'checkout_marker', where: '/checkout/' });
  });
});

function submission(path: string, fields: Record<string, string>): SubmissionSnapshot {
  return {
    url: `https://www.example.test${path}`,
    method: 'POST',
    fields: Object.entries(fields).map(([name, value]) => ({ name, value })),
  };
}

describe('detectPaymentSubmission', () => {
  it('sees a card number by its shape, whatever the field is called', () => {
    const verdict = detectPaymentSubmission(submission('/submit', { f1: '4242 4242 4242 4242' }));
    expect(verdict.payment).toBe(true);
    expect(verdict.evidence).toEqual([{ signal: 'card_value', where: 'f1' }]);
  });

  it('sees a card field by name even when empty, a security code by name and shape, and an expiry only with company', () => {
    expect(detectPaymentSubmission(submission('/submit', { card_number: '' })).payment).toBe(true);
    expect(detectPaymentSubmission(submission('/submit', { cvc: '123' })).payment).toBe(true);
    expect(detectPaymentSubmission(submission('/submit', { cvc: 'hello' })).payment).toBe(false);
    expect(detectPaymentSubmission(submission('/submit', { expiry: '12/34' })).payment).toBe(false);
    expect(detectPaymentSubmission(submission('/checkout', { expiry: '12/34' })).payment).toBe(true);
  });

  it('lets the fixture and ordinary forms through', () => {
    const ordinary = [
      submission('/login', { email: 'a@b.test', password: 'hunter2' }),
      submission('/cancel/confirm', { code: 'GYM-123456' }),
      submission('/orders/lookup', { order_ref: '1234567890123456' }),
      submission('/checkout/shipping', { address1: '1 Main St', postal_code: '94103' }),
      submission('/search', { q: '4242' }),
    ];
    for (const request of ordinary) expect(detectPaymentSubmission(request).payment).toBe(false);
  });

  it('does not choke on a target that is not a URL', () => {
    expect(detectPaymentSubmission({ url: 'not a url', method: 'POST', fields: [] }).payment).toBe(false);
  });
});

describe('parseSubmission', () => {
  const url = 'https://www.example.test/order';

  it('reads a form-encoded body', () => {
    const parsed = parseSubmission(url, 'post', 'application/x-www-form-urlencoded; charset=UTF-8', 'a=1&b=x%20y');
    expect(parsed).toEqual({
      url,
      method: 'POST',
      fields: [
        { name: 'a', value: '1' },
        { name: 'b', value: 'x y' },
      ],
    });
  });

  it('flattens a JSON body by path, a few levels down', () => {
    const body = JSON.stringify({ payment: { card: { number: '4111111111111111', cvc: 123 } }, save: true, note: null });
    expect(parseSubmission(url, 'POST', 'application/json', body).fields).toEqual([
      { name: 'payment.card.number', value: '4111111111111111' },
      { name: 'payment.card.cvc', value: '123' },
      { name: 'save', value: 'true' },
      { name: 'note', value: '' },
    ]);
    expect(parseSubmission(url, 'POST', 'application/vnd.api+json', '{"a":1}').fields).toEqual([{ name: 'a', value: '1' }]);
    expect(parseSubmission(url, 'POST', 'application/json', '{not json').fields).toEqual([]);
  });

  it('reads a multipart body', () => {
    const boundary = '----WebKitFormBoundary7MA4YWxk';
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="card_number"',
      '',
      '4242424242424242',
      `--${boundary}`,
      'Content-Disposition: form-data; name="note"',
      'Content-Type: text/plain',
      '',
      'a gift',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    expect(parseSubmission(url, 'POST', `multipart/form-data; boundary=${boundary}`, body).fields).toEqual([
      { name: 'card_number', value: '4242424242424242' },
      { name: 'note', value: 'a gift' },
    ]);
  });

  it('reads a text/plain form line by line', () => {
    expect(parseSubmission(url, 'POST', 'text/plain', 'cardnumber=4111111111111111\r\nnote=\r\nbare').fields).toEqual([
      { name: 'cardnumber', value: '4111111111111111' },
      { name: 'note', value: '' },
    ]);
  });

  it('yields no fields for a body it cannot read, or no body', () => {
    expect(parseSubmission(url, 'POST', 'application/octet-stream', 'binary').fields).toEqual([]);
    expect(parseSubmission(url, 'POST', undefined, 'a=1').fields).toEqual([]);
    expect(parseSubmission(url, 'POST', 'application/json', undefined).fields).toEqual([]);
    expect(parseSubmission(url, 'POST', 'application/json', '').fields).toEqual([]);
  });
});
