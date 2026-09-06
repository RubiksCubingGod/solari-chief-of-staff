/**
 * The payment detector: does this page, or this submission, look like money
 * about to move?
 *
 * Two views of one question, sharing one vocabulary. The page view looks at
 * forms as the browser sees them - card fields by autocomplete token and by
 * name, the verbs on the buttons, the words around them, the payment
 * processor's frame embedded in the page - and is what the question to the
 * person describes. The submission view looks at the request itself - the
 * field names in the body, and values shaped like a card number - and is what
 * the gate enforces on, because a request is the one thing a playbook step or
 * a model cannot phrase its way around.
 *
 * Uncertainty errs toward gating: a false positive costs one question; a
 * false negative is a payment nobody approved, and goes on the list of
 * recorded pages this detector is tested against.
 */

export interface FieldSnapshot {
  readonly name: string;
  readonly type: string;
  readonly autocomplete: string;
  readonly id: string;
  readonly label: string;
  readonly placeholder: string;
}

export interface FormSnapshot {
  readonly action: string;
  readonly method: string;
  readonly fields: readonly FieldSnapshot[];
  /** The text of every control that submits the form. */
  readonly submitLabels: readonly string[];
}

/** A page as the guard sees it: its forms, its embedded frames, and the visible text. */
export interface PageSnapshot {
  readonly url: string;
  readonly title: string;
  readonly forms: readonly FormSnapshot[];
  /** Hosts of the frames embedded in the page; a card form from a payment processor lives in one. */
  readonly frameHosts: readonly string[];
  readonly text: string;
}

export interface SubmissionField {
  readonly name: string;
  readonly value: string;
}

/** A request as the guard sees it: where it goes, and what its body carries. */
export interface SubmissionSnapshot {
  readonly url: string;
  readonly method: string;
  readonly fields: readonly SubmissionField[];
}

/**
 * What can count as evidence. The first four settle the question on their
 * own; `expiry` and `payment_verb` need a second signal; `checkout_marker`
 * only ever corroborates.
 */
export type PaymentSignal =
  | 'card_field'
  | 'card_value'
  | 'security_code'
  | 'processor_frame'
  | 'expiry'
  | 'payment_verb'
  | 'checkout_marker';

export interface PaymentEvidence {
  readonly signal: PaymentSignal;
  /** What carried it: a field name, a button label, a host, a marker's text. */
  readonly where: string;
}

export interface PaymentVerdict {
  readonly payment: boolean;
  /** Everything found, whether or not it added up to a payment. */
  readonly evidence: readonly PaymentEvidence[];
}

const CARD_AUTOCOMPLETE: ReadonlySet<string> = new Set([
  'cc-number',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'cc-csc',
  'cc-name',
  'cc-type',
]);

/** Words that mean the card, or the bank account, itself. */
const CARD_FIELD =
  /\b(?:card|cc|credit|debit)[\s_-]*(?:number|num|no|nr|pan)\b|\bcardnumber\b|\bccnum(?:ber)?\b|\bpan\b|\bcard[\s_-]*holder\b|\bname[\s_-]*on[\s_-]*card\b|\biban\b|\brouting[\s_-]*number\b/i;
const SECURITY_CODE =
  /\b(?:cvv2?|cvc|cvn|csc|cid)\b|\bsecurity[\s_-]*code\b|\bcard[\s_-]*(?:verification|security)[\s_-]*(?:code|value|number)?\b/i;
const EXPIRY =
  /\bexpir(?:y|ation|es)\b|\bexp[\s_-]*(?:date|month|year|mm|yy|m|y)\b|\bmm[\s_/-]*yy(?:yy)?\b|\bcc[\s_-]*exp\b/i;
/** A button whose whole label says money moves when it is pressed. */
const PAYMENT_VERB =
  /^\s*(?:pay(?:\s+now)?|pay\s+\S+|place\s+(?:your\s+|my\s+)?order|complete\s+(?:your\s+|my\s+)?(?:purchase|order|payment)|confirm\s+(?:and\s+pay|payment|purchase|order)|buy\s+now|purchase(?:\s+now)?|make\s+(?:a\s+)?payment|submit\s+payment|start\s+(?:my\s+|your\s+)?(?:subscription|membership|trial|plan)|subscribe\s+(?:now|and\s+pay)|checkout\s+now|donate(?:\s+now)?)\s*[.!]*\s*$/i;
/** A currency amount: a dollar, euro or pound sign before digits, or digits before a currency code. */
const AMOUNT = /[$€£]\s?\d|\b\d+(?:[.,]\d{2})?\s?(?:usd|eur|gbp|cad|aud)\b/i;
const CHECKOUT_MARKER =
  /\b(?:checkout|check\s+out|billing\s+(?:address|details|information|info)|order\s+(?:total|summary)|payment\s+(?:method|details|information|info)|card\s+number|total\s+due|amount\s+due|grand\s+total)\b/i;
const CHECKOUT_PATH = /\/(?:checkout|payments?|pay|billing|purchase|orders?|subscribe)(?:\/|$)/i;
const PROCESSOR_HOSTS: readonly string[] = [
  'stripe.com',
  'paypal.com',
  'paypalobjects.com',
  'braintreegateway.com',
  'braintree-api.com',
  'adyen.com',
  'squareup.com',
  'squarecdn.com',
  'checkout.com',
  'klarna.com',
  'authorize.net',
  'worldpay.com',
  'mollie.com',
  'recurly.com',
  'chargebee.com',
];

const SETTLES_ALONE: ReadonlySet<PaymentSignal> = new Set([
  'card_field',
  'card_value',
  'security_code',
  'processor_frame',
]);
const NEEDS_ANOTHER: ReadonlySet<PaymentSignal> = new Set(['expiry', 'payment_verb']);

function decide(evidence: readonly PaymentEvidence[]): PaymentVerdict {
  const strong = evidence.filter((item) => SETTLES_ALONE.has(item.signal)).length;
  const medium = evidence.filter((item) => NEEDS_ANOTHER.has(item.signal)).length;
  const weak = evidence.length - strong - medium;
  return { payment: strong > 0 || medium > 1 || (medium > 0 && weak > 0), evidence };
}

function underProcessor(host: string): boolean {
  const candidate = host.trim().toLowerCase();
  return PROCESSOR_HOSTS.some((root) => candidate === root || candidate.endsWith(`.${root}`));
}

function fieldEvidence(field: FieldSnapshot): PaymentEvidence | undefined {
  const where = [field.name, field.id, field.label, field.placeholder].find((word) => word !== '') ?? '';
  const token = field.autocomplete.trim().toLowerCase();
  if (CARD_AUTOCOMPLETE.has(token)) {
    return { signal: 'card_field', where: `${where} (autocomplete ${token})` };
  }
  const words = [field.name, field.id, field.label, field.placeholder].join(' ');
  if (CARD_FIELD.test(words)) return { signal: 'card_field', where };
  if (SECURITY_CODE.test(words)) return { signal: 'security_code', where };
  if (EXPIRY.test(words)) return { signal: 'expiry', where };
  return undefined;
}

export function detectPaymentPage(page: PageSnapshot): PaymentVerdict {
  const evidence: PaymentEvidence[] = [];
  for (const form of page.forms) {
    for (const field of form.fields) {
      const found = fieldEvidence(field);
      if (found !== undefined) evidence.push(found);
    }
    for (const label of form.submitLabels) {
      if (PAYMENT_VERB.test(label)) evidence.push({ signal: 'payment_verb', where: label });
      if (AMOUNT.test(label)) evidence.push({ signal: 'checkout_marker', where: label });
    }
  }
  for (const host of page.frameHosts) {
    if (underProcessor(host)) evidence.push({ signal: 'processor_frame', where: host });
  }
  const marker = CHECKOUT_MARKER.exec(page.text) ?? CHECKOUT_PATH.exec(page.url);
  if (marker !== null) evidence.push({ signal: 'checkout_marker', where: marker[0] });
  return decide(evidence);
}

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Thirteen to nineteen digits, spaces and dashes allowed, that pass the Luhn check. */
function cardShaped(value: string): boolean {
  const digits = value.replace(/[\s-]/g, '');
  return /^\d{13,19}$/.test(digits) && luhn(digits);
}

export function detectPaymentSubmission(submission: SubmissionSnapshot): PaymentVerdict {
  const evidence: PaymentEvidence[] = [];
  for (const field of submission.fields) {
    if (cardShaped(field.value)) evidence.push({ signal: 'card_value', where: field.name });
    else if (CARD_FIELD.test(field.name)) evidence.push({ signal: 'card_field', where: field.name });
    else if (SECURITY_CODE.test(field.name) && /^\s*\d{3,4}\s*$/.test(field.value)) {
      evidence.push({ signal: 'security_code', where: field.name });
    } else if (EXPIRY.test(field.name)) evidence.push({ signal: 'expiry', where: field.name });
  }
  let path = submission.url;
  try {
    path = new URL(submission.url).pathname;
  } catch {
    // Not a URL; the string itself is searched instead.
  }
  const marker = CHECKOUT_PATH.exec(path);
  if (marker !== null) evidence.push({ signal: 'checkout_marker', where: marker[0] });
  return decide(evidence);
}

/** JSON leaves as the text a person would have typed; anything that is not a scalar reads as nothing. */
function primitiveText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function flattenJson(body: string): SubmissionField[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const fields: SubmissionField[] = [];
  const walk = (value: unknown, path: string, depth: number): void => {
    if (depth > 4) return;
    if (value === null || typeof value !== 'object') {
      fields.push({ name: path, value: primitiveText(value) });
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      walk(child, path === '' ? key : `${path}.${key}`, depth + 1);
    }
  };
  walk(parsed, '', 0);
  return fields;
}

function parseMultipart(body: string): SubmissionField[] {
  const fields: SubmissionField[] = [];
  for (const part of body.split(/\r?\n?--[^\r\n]+(?:--)?\r?\n?/)) {
    const separator = part.search(/\r?\n\r?\n/);
    if (separator === -1) continue;
    const name = /name="([^"]*)"/.exec(part.slice(0, separator))?.[1];
    if (name === undefined) continue;
    fields.push({ name, value: part.slice(separator).replace(/^\r?\n\r?\n/, '') });
  }
  return fields;
}

/**
 * Reads a request body into fields, by content type. A body in a shape not
 * listed here yields no fields - and no evidence - which is the one place this
 * detector cannot err toward gating; the page view still can.
 */
export function parseSubmission(
  url: string,
  method: string,
  contentType: string | undefined,
  body: string | undefined,
): SubmissionSnapshot {
  const fields: SubmissionField[] = [];
  const type = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (body !== undefined && body !== '') {
    if (type === 'application/x-www-form-urlencoded') {
      for (const [name, value] of new URLSearchParams(body)) fields.push({ name, value });
    } else if (type === 'application/json' || type.endsWith('+json')) {
      fields.push(...flattenJson(body));
    } else if (type === 'multipart/form-data') {
      fields.push(...parseMultipart(body));
    } else if (type === 'text/plain') {
      for (const line of body.split(/\r?\n/)) {
        const equals = line.indexOf('=');
        if (equals > 0) fields.push({ name: line.slice(0, equals), value: line.slice(equals + 1) });
      }
    }
  }
  return { url, method: method.toUpperCase(), fields };
}

/** The evidence in a sentence, for the question a person is asked. */
export function describePaymentEvidence(evidence: readonly PaymentEvidence[]): string {
  return evidence.map((item) => `${item.signal.replaceAll('_', ' ')} "${item.where}"`).join('; ');
}
