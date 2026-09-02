import type { Page } from 'playwright';

/**
 * The page digest: what the model gets instead of the DOM (browser-toolset
 * spec). One bounded, typed reading of a page - URL, title, the interactive
 * elements a person could act on, each with a ref the tools accept back, and
 * the visible text - built by a script that runs inside the page and bounded
 * again here, so nothing the page can do makes the digest unbounded.
 *
 * Refs are stamped on the elements themselves. A ref handed out once names
 * the same element for as long as it is on the page, a rebuild of an
 * unchanged page hands out the same refs, and a ref is never reused for
 * another element: the counter lives with the toolset, not with the page, so
 * a new document gets new numbers. A ref whose element is gone, or whose
 * element no longer looks the way it did, is stale, and the tools say so
 * (see `tools.ts`).
 *
 * The page-side script is source text: the workspace compiles without DOM
 * types, and a string is also what `page.evaluate` runs.
 */

/** The attribute a digest stamps on each interactive element so a ref can find it again. */
export const REF_ATTRIBUTE = 'data-cos-ref';

/** What a ref looks like: `e` and a positive number, as the digest hands them out. */
export const REF_PATTERN = /^e[1-9][0-9]*$/;

export type ElementKind =
  | 'link'
  | 'button'
  | 'textbox'
  | 'textarea'
  | 'checkbox'
  | 'radio'
  | 'select'
  | 'other';

export type RegionRole = 'heading' | 'alert' | 'text';

export interface DigestOption {
  readonly value: string;
  readonly label: string;
  readonly selected: boolean;
}

/** One thing on the page a tool can act on. */
export interface DigestElement {
  readonly ref: string;
  readonly kind: ElementKind;
  /** The accessible label: aria-label, labelled-by, its `<label>`, its text, placeholder, title, or name; empty when it has none. */
  readonly label: string;
  /** Links only: the absolute URL. */
  readonly href?: string;
  /** Form fields: the `name` attribute. */
  readonly name?: string;
  /** Inputs: the `type` attribute. */
  readonly inputType?: string;
  /** Text fields: the current value. Never present for a password field. */
  readonly value?: string;
  readonly checked?: boolean;
  /** Present, and true, only when the element cannot be acted on. */
  readonly disabled?: boolean;
  /** Selects: the options, bounded by the limits. */
  readonly options?: readonly DigestOption[];
  readonly optionsOmitted?: number;
}

/** A run of visible text that is not an element's label. */
export interface DigestRegion {
  readonly role: RegionRole;
  readonly text: string;
}

/** What the limits left out, stated rather than silent. */
export interface DigestTruncation {
  readonly elementsOmitted: number;
  readonly regionsOmitted: number;
  /** Whether any label, value, or region text was cut to fit; a cut string ends in `…`. */
  readonly clipped: boolean;
}

export interface PageDigest {
  readonly url: string;
  readonly title: string;
  readonly elements: readonly DigestElement[];
  readonly regions: readonly DigestRegion[];
  readonly truncation: DigestTruncation;
}

export interface DigestLimits {
  readonly maxElements: number;
  readonly maxRegions: number;
  readonly maxLabelChars: number;
  readonly maxRegionChars: number;
  readonly maxValueChars: number;
  readonly maxOptions: number;
}

export const DEFAULT_DIGEST_LIMITS: DigestLimits = {
  maxElements: 120,
  maxRegions: 80,
  maxLabelChars: 120,
  maxRegionChars: 400,
  maxValueChars: 80,
  maxOptions: 24,
};

/** The digest builder's own failure: the page answered with something that is not a digest. */
export class DigestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DigestError';
  }
}

/* The page-side script. */

/**
 * Helpers shared by the digest and the ref lookup, so both describe an
 * element in exactly one way - the way the signature that detects a changed
 * element depends on.
 */
const PAGE_HELPERS = `
  var INLINE = { A: 1, ABBR: 1, B: 1, BDI: 1, BDO: 1, BR: 1, CITE: 1, CODE: 1, DATA: 1, DFN: 1, EM: 1, I: 1, IMG: 1, KBD: 1, MARK: 1, Q: 1, S: 1, SAMP: 1, SMALL: 1, SPAN: 1, STRONG: 1, SUB: 1, SUP: 1, TIME: 1, U: 1, VAR: 1, WBR: 1 };
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, META: 1, LINK: 1, TITLE: 1, SVG: 1, IFRAME: 1, OBJECT: 1, CANVAS: 1 };
  var CONTROL = { INPUT: 1, SELECT: 1, TEXTAREA: 1, BUTTON: 1 };
  var INTERACTIVE = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="textbox"], [role="combobox"], [role="menuitem"], [role="tab"], [role="option"], [contenteditable=""], [contenteditable="true"]';
  function flat(text) {
    return String(text == null ? '' : text).replace(/\\s+/g, ' ').trim();
  }
  function clip(text) {
    var cleaned = flat(text);
    return cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned;
  }
  function visible(el) {
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility()) return false;
    } else if (el.getClientRects().length === 0) {
      return false;
    }
    return el.closest('[aria-hidden="true"]') === null;
  }
  function innerText(el) {
    var out = '';
    for (var child = el.firstChild; child; child = child.nextSibling) out += fullText(child);
    return out;
  }
  function fullText(node) {
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1) return '';
    var tag = node.tagName;
    if (SKIP[tag] || CONTROL[tag]) return '';
    if (tag === 'IMG') return node.getAttribute('alt') || '';
    if (tag === 'BR') return ' ';
    return innerText(node);
  }
  function labelledBy(el) {
    var ids = (el.getAttribute('aria-labelledby') || '').split(/\\s+/);
    var parts = [];
    for (var i = 0; i < ids.length; i++) {
      var target = ids[i] ? document.getElementById(ids[i]) : null;
      if (target) parts.push(fullText(target));
    }
    return parts.join(' ');
  }
  function labelOf(el) {
    var tag = el.tagName;
    var type = (el.getAttribute('type') || '').toLowerCase();
    var candidates = [el.getAttribute('aria-label'), labelledBy(el)];
    if (el.labels) {
      for (var i = 0; i < el.labels.length; i++) candidates.push(fullText(el.labels[i]));
    }
    if (tag === 'INPUT') {
      if (type === 'submit' || type === 'button' || type === 'reset') candidates.push(el.value);
      if (type === 'submit') candidates.push('Submit');
      if (type === 'image') candidates.push(el.getAttribute('alt'));
      candidates.push(el.getAttribute('placeholder'));
    } else if (tag === 'TEXTAREA') {
      candidates.push(el.getAttribute('placeholder'));
    } else {
      candidates.push(innerText(el));
    }
    candidates.push(el.getAttribute('title'), el.getAttribute('name'));
    for (var j = 0; j < candidates.length; j++) {
      var candidate = flat(candidates[j]);
      if (candidate) return candidate;
    }
    return '';
  }
  function kindOf(el) {
    var tag = el.tagName;
    var role = (el.getAttribute('role') || '').toLowerCase();
    var type = (el.getAttribute('type') || 'text').toLowerCase();
    if (tag === 'A') return 'link';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'SELECT') return 'select';
    if (tag === 'TEXTAREA') return 'textarea';
    if (tag === 'INPUT') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textarea';
    if (role === 'link') return 'link';
    if (role === 'button' || role === 'menuitem' || role === 'tab' || role === 'option') return 'button';
    if (role === 'checkbox') return 'checkbox';
    if (role === 'radio') return 'radio';
    if (role === 'textbox' || role === 'combobox') return 'textbox';
    return 'other';
  }
  function describe(el) {
    var tag = el.tagName;
    var kind = kindOf(el);
    var label = clip(labelOf(el));
    var out = { kind: kind, label: label };
    if (tag === 'A') out.href = el.href;
    var name = el.getAttribute('name');
    if (name) out.name = name;
    if (tag === 'INPUT') out.inputType = (el.getAttribute('type') || 'text').toLowerCase();
    if ((kind === 'textbox' || kind === 'textarea') && out.inputType !== 'password') {
      out.value = clip(tag === 'INPUT' || tag === 'TEXTAREA' ? el.value : innerText(el));
    }
    if (kind === 'checkbox' || kind === 'radio') {
      out.checked = tag === 'INPUT' ? !!el.checked : el.getAttribute('aria-checked') === 'true';
    }
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') out.disabled = true;
    if (tag === 'SELECT') {
      var options = [];
      for (var i = 0; i < el.options.length && i < maxOptions; i++) {
        var option = el.options[i];
        options.push({ value: option.value, label: clip(option.label || option.text), selected: option.selected });
      }
      out.options = options;
      if (el.options.length > maxOptions) out.optionsOmitted = el.options.length - maxOptions;
    }
    out.signature = kind + '|' + label + '|' + (out.href || '') + '|' + (name || '');
    return out;
  }
`;

/**
 * Builds the raw digest inside the page: stamps every visible interactive
 * element that has no ref yet, describes the first `maxElements` of them,
 * collects the first `maxRegions` runs of visible text, and counts the rest.
 */
const DIGEST_SCRIPT = `(function (options) {
  var attribute = options.attribute;
  var nextRef = options.nextRef;
  var maxChars = options.maxChars;
  var maxOptions = options.maxOptions;
  ${PAGE_HELPERS}
  var elements = [];
  var elementTotal = 0;
  var all = document.querySelectorAll(INTERACTIVE);
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'hidden') continue;
    if (!visible(el)) continue;
    var ref = el.getAttribute(attribute);
    if (!ref) {
      ref = 'e' + String(nextRef++);
      el.setAttribute(attribute, ref);
    }
    elementTotal++;
    if (elements.length < options.maxElements) {
      var described = describe(el);
      described.ref = ref;
      elements.push(described);
    }
  }
  var regions = [];
  var regionTotal = 0;
  function roleOf(el) {
    var role = (el.getAttribute('role') || '').toLowerCase();
    if (/^H[1-6]$/.test(el.tagName) || role === 'heading') return 'heading';
    if (role === 'alert' || role === 'status') return 'alert';
    return 'text';
  }
  function ownText(el) {
    var own = '';
    var withLinks = '';
    for (var child = el.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) {
        own += child.nodeValue;
        withLinks += child.nodeValue;
      } else if (child.nodeType === 1 && INLINE[child.tagName]) {
        var piece = fullText(child);
        withLinks += piece;
        if (!child.matches(INTERACTIVE)) own += piece;
      }
    }
    return flat(own) ? withLinks : '';
  }
  function walk(el) {
    if (SKIP[el.tagName] || !visible(el) || el.matches(INTERACTIVE)) return;
    if (el.tagName === 'LABEL' && el.control) return;
    var text = clip(ownText(el));
    if (text) {
      regionTotal++;
      if (regions.length < options.maxRegions) regions.push({ role: roleOf(el), text: text });
    }
    for (var child = el.firstElementChild; child; child = child.nextElementSibling) {
      if (!INLINE[child.tagName]) walk(child);
    }
  }
  if (document.body) walk(document.body);
  return {
    url: location.href,
    title: document.title,
    elements: elements,
    elementTotal: elementTotal,
    regions: regions,
    regionTotal: regionTotal,
    nextRef: nextRef,
  };
})`;

/** Finds the element a ref was stamped on and describes it the way the digest did. */
const RESOLVE_SCRIPT = `(function (options) {
  var maxChars = options.maxChars;
  var maxOptions = options.maxOptions;
  ${PAGE_HELPERS}
  var el = document.querySelector('[' + options.attribute + '="' + options.ref + '"]');
  if (!el) return { found: false };
  var described = describe(el);
  described.found = true;
  described.visible = visible(el);
  return described;
})`;

export interface DigestScriptOptions {
  readonly attribute: string;
  readonly nextRef: number;
  readonly maxElements: number;
  readonly maxRegions: number;
  readonly maxOptions: number;
  /** The longest string the page may send back; the bounding here cuts to the real limits. */
  readonly maxChars: number;
}

/** The expression `page.evaluate` runs to build a raw digest. */
export function digestScript(options: DigestScriptOptions): string {
  return `${DIGEST_SCRIPT}(${JSON.stringify(options)})`;
}

export interface ResolveScriptOptions {
  readonly attribute: string;
  readonly ref: string;
  readonly maxOptions: number;
  readonly maxChars: number;
}

/** The expression `page.evaluate` runs to look a ref up. */
export function resolveScript(options: ResolveScriptOptions): string {
  return `${RESOLVE_SCRIPT}(${JSON.stringify(options)})`;
}

/* What the page sends back. */

/** An element as the page describes it: unbounded apart from `maxChars`, with the signature the lookup compares. */
export interface RawElement {
  readonly kind: ElementKind;
  readonly label: string;
  readonly signature: string;
  readonly href?: string;
  readonly name?: string;
  readonly inputType?: string;
  readonly value?: string;
  readonly checked?: boolean;
  readonly disabled?: boolean;
  readonly options?: readonly DigestOption[];
  readonly optionsOmitted?: number;
}

export interface RawDigestElement extends RawElement {
  readonly ref: string;
}

export interface RawDigest {
  readonly url: string;
  readonly title: string;
  readonly elements: readonly RawDigestElement[];
  readonly elementTotal: number;
  readonly regions: readonly DigestRegion[];
  readonly regionTotal: number;
  readonly nextRef: number;
}

/** What the lookup answers: nothing stamped with the ref, or the element as it is now. */
export type Located =
  | { readonly found: false }
  | (RawElement & { readonly found: true; readonly visible: boolean });

const ELEMENT_KINDS: readonly string[] = [
  'link',
  'button',
  'textbox',
  'textarea',
  'checkbox',
  'radio',
  'select',
  'other',
];
const REGION_ROLES: readonly string[] = ['heading', 'alert', 'text'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function isOption(value: unknown): value is DigestOption {
  return (
    isRecord(value) &&
    typeof value['value'] === 'string' &&
    typeof value['label'] === 'string' &&
    typeof value['selected'] === 'boolean'
  );
}

export function isRawElement(value: unknown): value is RawElement {
  if (!isRecord(value)) return false;
  return (
    typeof value['kind'] === 'string' &&
    ELEMENT_KINDS.includes(value['kind']) &&
    typeof value['label'] === 'string' &&
    typeof value['signature'] === 'string' &&
    optionalString(value['href']) &&
    optionalString(value['name']) &&
    optionalString(value['inputType']) &&
    optionalString(value['value']) &&
    optionalBoolean(value['checked']) &&
    optionalBoolean(value['disabled']) &&
    (value['options'] === undefined ||
      (Array.isArray(value['options']) && value['options'].every(isOption))) &&
    (value['optionsOmitted'] === undefined || typeof value['optionsOmitted'] === 'number')
  );
}

function isRegion(value: unknown): value is DigestRegion {
  return (
    isRecord(value) &&
    typeof value['role'] === 'string' &&
    REGION_ROLES.includes(value['role']) &&
    typeof value['text'] === 'string'
  );
}

export function isRawDigest(value: unknown): value is RawDigest {
  if (!isRecord(value)) return false;
  return (
    typeof value['url'] === 'string' &&
    typeof value['title'] === 'string' &&
    Array.isArray(value['elements']) &&
    value['elements'].every(
      (element: unknown) => isRawElement(element) && typeof (element as { ref?: unknown }).ref === 'string',
    ) &&
    typeof value['elementTotal'] === 'number' &&
    Array.isArray(value['regions']) &&
    value['regions'].every(isRegion) &&
    typeof value['regionTotal'] === 'number' &&
    typeof value['nextRef'] === 'number'
  );
}

export function isLocated(value: unknown): value is Located {
  if (!isRecord(value)) return false;
  if (value['found'] === false) return true;
  return value['found'] === true && typeof value['visible'] === 'boolean' && isRawElement(value);
}

/* Bounding: the limits applied, and the cuts marked. */

const ELLIPSIS = '…';

interface Clipped {
  readonly text: string;
  readonly clipped: boolean;
}

/** Cuts `text` to `max` characters, the last one an ellipsis when anything was cut. */
export function clipText(text: string, max: number): Clipped {
  if (text.length <= max) return { text, clipped: false };
  return { text: `${text.slice(0, Math.max(max - 1, 0))}${ELLIPSIS}`, clipped: true };
}

/** A digest under its limits, with the signatures the toolset keeps for the refs it holds. */
export interface DigestReading {
  readonly digest: PageDigest;
  readonly signatures: ReadonlyMap<string, string>;
  /** The number the next new element gets, to carry into the next digest. */
  readonly nextRef: number;
}

/**
 * Applies the limits to what the page sent back: clips every string to its
 * limit, keeps the counts of what did not fit, and separates the signatures
 * (which the model never sees) from the digest (which it does).
 */
export function boundDigest(raw: RawDigest, limits: DigestLimits): DigestReading {
  let clipped = false;
  const cut = (text: string, max: number): string => {
    const result = clipText(text, max);
    clipped = clipped || result.clipped;
    return result.text;
  };
  const signatures = new Map<string, string>();
  const elements: DigestElement[] = raw.elements.slice(0, limits.maxElements).map((element) => {
    signatures.set(element.ref, element.signature);
    const options = element.options?.slice(0, limits.maxOptions);
    const optionsOmitted =
      element.options === undefined
        ? undefined
        : (element.optionsOmitted ?? 0) + (element.options.length - (options?.length ?? 0));
    return {
      ref: element.ref,
      kind: element.kind,
      label: cut(element.label, limits.maxLabelChars),
      ...(element.href === undefined ? {} : { href: element.href }),
      ...(element.name === undefined ? {} : { name: element.name }),
      ...(element.inputType === undefined ? {} : { inputType: element.inputType }),
      ...(element.value === undefined ? {} : { value: cut(element.value, limits.maxValueChars) }),
      ...(element.checked === undefined ? {} : { checked: element.checked }),
      ...(element.disabled === undefined ? {} : { disabled: element.disabled }),
      ...(options === undefined
        ? {}
        : {
            options: options.map((option) => ({
              value: option.value,
              label: cut(option.label, limits.maxLabelChars),
              selected: option.selected,
            })),
          }),
      ...(optionsOmitted === undefined || optionsOmitted === 0 ? {} : { optionsOmitted }),
    };
  });
  const regions: DigestRegion[] = raw.regions.slice(0, limits.maxRegions).map((region) => ({
    role: region.role,
    text: cut(region.text, limits.maxRegionChars),
  }));
  return {
    digest: {
      url: raw.url,
      title: raw.title,
      elements,
      regions,
      truncation: {
        elementsOmitted: Math.max(raw.elementTotal - elements.length, 0),
        regionsOmitted: Math.max(raw.regionTotal - regions.length, 0),
        clipped,
      },
    },
    signatures,
    nextRef: raw.nextRef,
  };
}

export interface DigestPageOptions {
  readonly limits?: Partial<DigestLimits>;
  /** The number the first new element gets; the previous reading's `nextRef` when there was one. */
  readonly nextRef?: number;
}

/**
 * The longest string the page may send back under `limits`: one more than
 * the longest limit, so the bounding here can tell a string that fit from one
 * that was cut. The ref lookup uses the same bound, because the signature it
 * compares is built from the same clipped label.
 */
export function maxCharsFor(limits: DigestLimits): number {
  return Math.max(limits.maxLabelChars, limits.maxRegionChars, limits.maxValueChars) + 1;
}

/** Reads the page: runs the digest script and bounds what came back. */
export async function digestPage(page: Page, options: DigestPageOptions = {}): Promise<DigestReading> {
  const limits: DigestLimits = { ...DEFAULT_DIGEST_LIMITS, ...options.limits };
  const raw: unknown = await page.evaluate(
    digestScript({
      attribute: REF_ATTRIBUTE,
      nextRef: options.nextRef ?? 1,
      maxElements: limits.maxElements,
      maxRegions: limits.maxRegions,
      maxOptions: limits.maxOptions,
      maxChars: maxCharsFor(limits),
    }),
  );
  if (!isRawDigest(raw)) throw new DigestError('the page answered the digest script with something else');
  return boundDigest(raw, limits);
}

/* Rendering: the digest as the model reads it. */

function quote(text: string): string {
  return `"${text}"`;
}

function describeElement(element: DigestElement): string {
  const parts = [`[${element.ref}] ${element.kind} ${quote(element.label)}`];
  if (element.href !== undefined) parts.push(`-> ${element.href}`);
  if (element.name !== undefined) parts.push(`name=${element.name}`);
  if (element.inputType !== undefined && element.kind === 'textbox') parts.push(`type=${element.inputType}`);
  if (element.value !== undefined) parts.push(`value=${quote(element.value)}`);
  if (element.checked !== undefined) parts.push(element.checked ? '(checked)' : '(unchecked)');
  if (element.options !== undefined) {
    const options = element.options.map(
      (option) => `${option.value}=${quote(option.label)}${option.selected ? ' (selected)' : ''}`,
    );
    parts.push(`options: ${options.join(', ')}`);
    if (element.optionsOmitted !== undefined) {
      parts.push(`(${String(element.optionsOmitted)} more options not shown)`);
    }
  }
  if (element.disabled === true) parts.push('(disabled)');
  return parts.join(' ');
}

function describeRegion(region: DigestRegion): string {
  switch (region.role) {
    case 'heading':
      return `# ${region.text}`;
    case 'alert':
      return `! ${region.text}`;
    case 'text':
      return region.text;
  }
}

/**
 * The digest as text, one line per element and per region, with what was left
 * out said in so many words. This is what a tool result carries; the model
 * never sees the structured form.
 */
export function renderDigest(digest: PageDigest): string {
  const lines: string[] = [`Page: ${quote(digest.title)} at ${digest.url}`];
  lines.push(`Interactive elements (${String(digest.elements.length)}):`);
  for (const element of digest.elements) lines.push(`  ${describeElement(element)}`);
  if (digest.truncation.elementsOmitted > 0) {
    lines.push(
      `  ... ${String(digest.truncation.elementsOmitted)} more interactive elements were left out of this digest.`,
    );
  }
  lines.push(`Visible text (${String(digest.regions.length)}):`);
  for (const region of digest.regions) lines.push(`  ${describeRegion(region)}`);
  if (digest.truncation.regionsOmitted > 0) {
    lines.push(`  ... ${String(digest.truncation.regionsOmitted)} more text regions were left out of this digest.`);
  }
  if (digest.truncation.clipped) {
    lines.push('Some text was cut to fit this digest; a trailing … marks a cut.');
  }
  return lines.join('\n');
}
