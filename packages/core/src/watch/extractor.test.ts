import { describe, expect, it } from 'vitest';

import {
  EXTRACTOR_PARSERS,
  EXTRACTOR_SPEC_VERSION,
  EXTRACTOR_STRATEGIES,
  hasExtractor,
  isExtractorParser,
  isExtractorStrategy,
  parseExtractorSpec,
  parserForKind,
} from './extractor.js';

const SPEC = {
  version: 1,
  strategy: 'css',
  selector: '[data-testid="product-price"]',
  attribute: null,
  parse: 'price',
};

describe('the extractor vocabulary', () => {
  it('has one strategy and three parsers', () => {
    expect(EXTRACTOR_STRATEGIES).toEqual(['css']);
    expect(EXTRACTOR_PARSERS).toEqual(['price', 'digest', 'slots']);
    expect(EXTRACTOR_SPEC_VERSION).toBe(1);
  });

  it('guards both lists', () => {
    expect(isExtractorStrategy('css')).toBe(true);
    expect(isExtractorStrategy('xpath')).toBe(false);
    expect(isExtractorParser('digest')).toBe(true);
    expect(isExtractorParser('number')).toBe(false);
  });
});

describe('parseExtractorSpec', () => {
  it('accepts a complete spec as stored', () => {
    expect(parseExtractorSpec(SPEC)).toEqual(SPEC);
  });

  it('accepts an omitted attribute as null and an explicit one as itself', () => {
    const withoutAttribute = { version: 1, strategy: 'css', selector: SPEC.selector, parse: 'price' };
    expect(parseExtractorSpec(withoutAttribute)).toEqual(SPEC);
    expect(parseExtractorSpec({ ...SPEC, attribute: 'content' })?.attribute).toBe('content');
  });

  it('treats the empty object a new watch is created with as no extractor', () => {
    expect(parseExtractorSpec({})).toBeUndefined();
    expect(hasExtractor({})).toBe(false);
    expect(hasExtractor(SPEC)).toBe(true);
  });

  it.each([
    ['not an object', 'css'],
    ['null', null],
    ['an array', [SPEC]],
    ['an unknown key', { ...SPEC, script: 'alert(1)' }],
    ['another version', { ...SPEC, version: 2 }],
    ['an unknown strategy', { ...SPEC, strategy: 'xpath' }],
    ['an unknown parser', { ...SPEC, parse: 'number' }],
    ['a missing selector', { ...SPEC, selector: undefined }],
    ['a blank selector', { ...SPEC, selector: '  ' }],
    ['a non-string attribute', { ...SPEC, attribute: 3 }],
    ['a blank attribute', { ...SPEC, attribute: '' }],
  ])('refuses %s', (_label, value) => {
    expect(parseExtractorSpec(value)).toBeUndefined();
  });
});

describe('parserForKind', () => {
  it('pairs every kind with its parser', () => {
    expect(parserForKind('price')).toBe('price');
    expect(parserForKind('change')).toBe('digest');
    expect(parserForKind('slot')).toBe('slots');
  });
});
