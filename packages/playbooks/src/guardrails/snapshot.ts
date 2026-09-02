import type { Page } from 'playwright';

import type { PageSnapshot } from './payment-detector.js';

/**
 * Runs inside the page. Kept as source text rather than a function because
 * this package compiles without the DOM library, which the workspace does not
 * hand to server code; the shape that comes back is checked on this side.
 */
export const SNAPSHOT_SCRIPT = `(() => {
  const text = (node) => (node && node.textContent ? node.textContent : '').replace(/\\s+/g, ' ').trim();
  const labelOf = (field) => {
    const id = field.getAttribute('id');
    const explicit = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]') : null;
    return text(explicit || field.closest('label')) || field.getAttribute('aria-label') || '';
  };
  const isField = (el) =>
    el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;
  const isButton = (el) =>
    el instanceof HTMLInputElement && ['submit', 'button', 'reset', 'image'].includes(el.type);
  const forms = Array.from(document.forms).map((form) => ({
    action: form.getAttribute('action') || '',
    method: (form.getAttribute('method') || 'get').toLowerCase(),
    fields: Array.from(form.elements)
      .filter((el) => isField(el) && !isButton(el))
      .map((el) => ({
        name: el.getAttribute('name') || '',
        type: el instanceof HTMLInputElement ? el.type : el.tagName.toLowerCase(),
        autocomplete: el.getAttribute('autocomplete') || '',
        id: el.getAttribute('id') || '',
        label: labelOf(el),
        placeholder: el.getAttribute('placeholder') || '',
      })),
    submitLabels: Array.from(
      form.querySelectorAll('button:not([type=button]):not([type=reset]), input[type=submit], input[type=image]'),
    )
      .map((el) => (el instanceof HTMLInputElement ? el.value || el.getAttribute('alt') || '' : text(el)))
      .filter((label) => label !== ''),
  }));
  const frameHosts = Array.from(document.querySelectorAll('iframe[src]'))
    .map((frame) => {
      try {
        return new URL(frame.getAttribute('src'), document.baseURI).hostname;
      } catch {
        return '';
      }
    })
    .filter((host) => host !== '');
  return {
    url: location.href,
    title: document.title,
    forms,
    frameHosts,
    text: text(document.body).slice(0, 4000),
  };
})()`;

export function isPageSnapshot(value: unknown): value is PageSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.url === 'string' &&
    typeof record.title === 'string' &&
    typeof record.text === 'string' &&
    Array.isArray(record.forms) &&
    Array.isArray(record.frameHosts)
  );
}

/** What the page currently shows, in the detector's terms. */
export async function snapshotPage(page: Page): Promise<PageSnapshot> {
  const snapshot: unknown = await page.evaluate(SNAPSHOT_SCRIPT);
  if (!isPageSnapshot(snapshot)) {
    throw new Error('the page snapshot script returned an unexpected shape');
  }
  return snapshot;
}
