import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DIGEST_LIMITS,
  boundDigest,
  clipText,
  digestScript,
  isLocated,
  isRawDigest,
  isRawElement,
  maxCharsFor,
  renderDigest,
  resolveScript,
  type DigestLimits,
  type RawDigest,
} from './digest.js';

/**
 * The digest's pure half: the bounding that turns what the page sent into
 * what the model gets, the rendering the model reads, and the guards on what
 * the page is allowed to answer. What needs a browser - the script itself -
 * is proven in `agentic.integration.test.ts`.
 */

const LIMITS: DigestLimits = {
  maxElements: 3,
  maxRegions: 2,
  maxLabelChars: 12,
  maxRegionChars: 20,
  maxValueChars: 8,
  maxOptions: 2,
};

function raw(overrides: Partial<RawDigest> = {}): RawDigest {
  return {
    url: 'http://127.0.0.1:1/form',
    title: 'Form',
    elements: [
      { ref: 'e1', kind: 'link', label: 'Home', href: 'http://127.0.0.1:1/', signature: 'link|Home|http://127.0.0.1:1/|' },
      {
        ref: 'e2',
        kind: 'textbox',
        label: 'Email address of the member',
        name: 'email',
        inputType: 'email',
        value: 'someone@example.test',
        signature: 'textbox|Email address of the member||email',
      },
      {
        ref: 'e3',
        kind: 'select',
        label: 'Plan',
        name: 'plan',
        options: [
          { value: 'm', label: 'Monthly', selected: false },
          { value: 'a', label: 'Annual', selected: true },
          { value: 'w', label: 'Weekly', selected: false },
        ],
        signature: 'select|Plan||plan',
      },
      { ref: 'e4', kind: 'button', label: 'Send', disabled: true, signature: 'button|Send||' },
    ],
    elementTotal: 9,
    regions: [
      { role: 'heading', text: 'Form' },
      { role: 'text', text: 'A paragraph long enough to be cut.' },
      { role: 'alert', text: 'Unsaved' },
    ],
    regionTotal: 5,
    nextRef: 10,
    ...overrides,
  };
}

describe('clipText', () => {
  it('leaves what fits alone and ends a cut with an ellipsis inside the limit', () => {
    expect(clipText('short', 5)).toEqual({ text: 'short', clipped: false });
    expect(clipText('too long', 5)).toEqual({ text: 'too …', clipped: true });
    expect(clipText('x', 0)).toEqual({ text: '…', clipped: true });
  });
});

describe('boundDigest', () => {
  it('applies every limit, counts what it left out, and keeps the signatures apart', () => {
    const reading = boundDigest(raw(), LIMITS);

    expect(reading.digest.elements).toHaveLength(3);
    expect(reading.digest.elements[1]).toEqual({
      ref: 'e2',
      kind: 'textbox',
      label: 'Email addre…',
      name: 'email',
      inputType: 'email',
      value: 'someone…',
    });
    expect(reading.digest.elements[2]).toEqual({
      ref: 'e3',
      kind: 'select',
      label: 'Plan',
      name: 'plan',
      options: [
        { value: 'm', label: 'Monthly', selected: false },
        { value: 'a', label: 'Annual', selected: true },
      ],
      optionsOmitted: 1,
    });
    expect(reading.digest.regions).toEqual([
      { role: 'heading', text: 'Form' },
      { role: 'text', text: 'A paragraph long en…' },
    ]);
    expect(reading.digest.truncation).toEqual({ elementsOmitted: 6, regionsOmitted: 3, clipped: true });
    expect(reading.nextRef).toBe(10);
    expect([...reading.signatures]).toEqual([
      ['e1', 'link|Home|http://127.0.0.1:1/|'],
      ['e2', 'textbox|Email address of the member||email'],
      ['e3', 'select|Plan||plan'],
    ]);
    expect(JSON.stringify(reading.digest)).not.toContain('signature');
  });

  it('reports nothing cut when everything fits, and never a negative count', () => {
    const reading = boundDigest(raw({ elementTotal: 2, regionTotal: 1 }), DEFAULT_DIGEST_LIMITS);

    expect(reading.digest.elements).toHaveLength(4);
    expect(reading.digest.elements[3]).toEqual({ ref: 'e4', kind: 'button', label: 'Send', disabled: true });
    expect(reading.digest.elements[2]?.optionsOmitted).toBeUndefined();
    expect(reading.digest.truncation).toEqual({ elementsOmitted: 0, regionsOmitted: 0, clipped: false });
  });

  it('adds what the page already left out of a select to what the limit cuts', () => {
    const reading = boundDigest(
      raw({
        elements: [
          {
            ref: 'e1',
            kind: 'select',
            label: 'Country',
            options: [
              { value: 'a', label: 'A', selected: true },
              { value: 'b', label: 'B', selected: false },
              { value: 'c', label: 'C', selected: false },
            ],
            optionsOmitted: 40,
            signature: 'select|Country||',
          },
        ],
        elementTotal: 1,
      }),
      LIMITS,
    );

    expect(reading.digest.elements[0]?.options).toHaveLength(2);
    expect(reading.digest.elements[0]?.optionsOmitted).toBe(41);
  });
});

describe('renderDigest', () => {
  it('lists every element and region on its own line and says what was left out', () => {
    const text = renderDigest(boundDigest(raw(), LIMITS).digest);

    expect(text.split('\n')).toEqual([
      'Page: "Form" at http://127.0.0.1:1/form',
      'Interactive elements (3):',
      '  [e1] link "Home" -> http://127.0.0.1:1/',
      '  [e2] textbox "Email addre…" name=email type=email value="someone…"',
      '  [e3] select "Plan" name=plan options: m="Monthly", a="Annual" (selected) (1 more options not shown)',
      '  ... 6 more interactive elements were left out of this digest.',
      'Visible text (2):',
      '  # Form',
      '  A paragraph long en…',
      '  ... 3 more text regions were left out of this digest.',
      'Some text was cut to fit this digest; a trailing … marks a cut.',
    ]);
  });

  it('marks checked state, disabled buttons and alerts', () => {
    const text = renderDigest(
      boundDigest(
        raw({
          elements: [
            { ref: 'e1', kind: 'checkbox', label: 'Remember me', checked: true, signature: 'x' },
            { ref: 'e2', kind: 'radio', label: 'Monthly', checked: false, signature: 'y' },
            { ref: 'e3', kind: 'button', label: 'Locked', disabled: true, signature: 'z' },
          ],
          elementTotal: 3,
          regions: [{ role: 'alert', text: 'Unsaved changes' }],
          regionTotal: 1,
        }),
        DEFAULT_DIGEST_LIMITS,
      ).digest,
    );

    expect(text).toContain('[e1] checkbox "Remember me" (checked)');
    expect(text).toContain('[e2] radio "Monthly" (unchecked)');
    expect(text).toContain('[e3] button "Locked" (disabled)');
    expect(text).toContain('  ! Unsaved changes');
    expect(text).not.toContain('left out');
    expect(text).not.toContain('cut to fit');
  });
});

describe('the guards on what the page answers', () => {
  it('accepts a well-formed raw digest and refuses anything else', () => {
    expect(isRawDigest(raw())).toBe(true);
    expect(isRawDigest(null)).toBe(false);
    expect(isRawDigest([])).toBe(false);
    expect(isRawDigest({ ...raw(), elements: [{ ref: 'e1', kind: 'widget', label: '', signature: '' }] })).toBe(
      false,
    );
    expect(isRawDigest({ ...raw(), elements: [{ kind: 'link', label: '', signature: '' }] })).toBe(false);
    expect(isRawDigest({ ...raw(), regions: [{ role: 'footer', text: '' }] })).toBe(false);
    expect(isRawDigest({ ...raw(), nextRef: '10' })).toBe(false);
    expect(isRawDigest({ ...raw(), elementTotal: undefined })).toBe(false);
  });

  it('checks each optional field of an element by type', () => {
    const element = { kind: 'link', label: 'Home', signature: 's' };
    expect(isRawElement(element)).toBe(true);
    expect(isRawElement({ ...element, href: 1 })).toBe(false);
    expect(isRawElement({ ...element, checked: 'yes' })).toBe(false);
    expect(isRawElement({ ...element, options: [{ value: 'a', label: 'A' }] })).toBe(false);
    expect(isRawElement({ ...element, optionsOmitted: 'many' })).toBe(false);
    expect(isRawElement('link')).toBe(false);
  });

  it('accepts both answers to a ref lookup and nothing in between', () => {
    expect(isLocated({ found: false })).toBe(true);
    expect(isLocated({ found: true, visible: true, kind: 'button', label: 'Go', signature: 's' })).toBe(true);
    expect(isLocated({ found: true, kind: 'button', label: 'Go', signature: 's' })).toBe(false);
    expect(isLocated({ found: 'maybe' })).toBe(false);
    expect(isLocated(undefined)).toBe(false);
  });
});

describe('the scripts', () => {
  it('are self-contained expressions that carry their options as JSON', () => {
    const digest = digestScript({
      attribute: 'data-cos-ref',
      nextRef: 7,
      maxElements: 1,
      maxRegions: 1,
      maxOptions: 1,
      maxChars: 9,
    });
    expect(digest.startsWith('(function (options) {')).toBe(true);
    expect(digest.endsWith('})({"attribute":"data-cos-ref","nextRef":7,"maxElements":1,"maxRegions":1,"maxOptions":1,"maxChars":9})')).toBe(true);

    const resolve = resolveScript({ attribute: 'data-cos-ref', ref: 'e7', maxOptions: 1, maxChars: 9 });
    expect(resolve.endsWith('})({"attribute":"data-cos-ref","ref":"e7","maxOptions":1,"maxChars":9})')).toBe(true);
    expect(resolve).toContain('return { found: false }');
  });

  it('bound what the page may send back by the longest limit plus one', () => {
    expect(maxCharsFor(LIMITS)).toBe(21);
    expect(maxCharsFor(DEFAULT_DIGEST_LIMITS)).toBe(401);
  });
});
