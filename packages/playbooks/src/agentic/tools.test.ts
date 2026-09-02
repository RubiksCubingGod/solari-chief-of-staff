import { describe, expect, it } from 'vitest';

import type { PageDigest } from './digest.js';
import {
  BROWSER_TOOLS,
  OUTCOME_STATUSES,
  TOOL_NAMES,
  describeToolFailure,
  isToolName,
  parseToolInput,
  trailDetail,
  type ToolExecution,
  type ToolFailure,
} from './tools.js';

/**
 * The tool surface's pure half: the schemas, the words for each failure, and
 * what the trail keeps. Running the tools against a page is proven in
 * `agentic.integration.test.ts`.
 */

describe('the tool definitions', () => {
  it('name the seven tools in order, each with a description and a JSON schema', () => {
    expect(BROWSER_TOOLS.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
    for (const tool of BROWSER_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.jsonSchema['type']).toBe('object');
      expect(tool.jsonSchema).not.toHaveProperty('$schema');
    }
    const click = BROWSER_TOOLS.find((tool) => tool.name === 'click');
    expect(click?.jsonSchema).toMatchObject({
      properties: { ref: { type: 'string', pattern: '^e[1-9][0-9]*$' } },
      required: ['ref'],
    });
    const outcome = BROWSER_TOOLS.find((tool) => tool.name === 'declare_outcome');
    expect(outcome?.jsonSchema).toMatchObject({
      properties: { status: { enum: [...OUTCOME_STATUSES] } },
      required: ['status', 'detail'],
    });
  });

  it('knows its own names and nothing else', () => {
    expect(isToolName('click')).toBe(true);
    expect(isToolName('scroll')).toBe(false);
    expect(isToolName('')).toBe(false);
  });
});

describe('parseToolInput', () => {
  it('accepts a well-formed call and trims what it should', () => {
    expect(parseToolInput('navigate', { url: 'https://example.test/a?b=c' })).toEqual({
      ok: true,
      args: { url: 'https://example.test/a?b=c' },
    });
    expect(parseToolInput('type', { ref: 'e12', text: '' })).toEqual({ ok: true, args: { ref: 'e12', text: '' } });
    expect(parseToolInput('read', {})).toEqual({ ok: true, args: {} });
    expect(parseToolInput('ask_user', { question: '  What is the code?  ' })).toEqual({
      ok: true,
      args: { question: 'What is the code?' },
    });
    expect(parseToolInput('declare_outcome', { status: 'blocked', detail: ' captcha ' })).toEqual({
      ok: true,
      args: { status: 'blocked', detail: 'captcha' },
    });
  });

  it('names every field that does not fit, in words the model can act on', () => {
    const missing = parseToolInput('type', { ref: 'e1' });
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error('unreachable');
    expect(missing.failure).toMatchObject({ kind: 'invalid-arguments', tool: 'type' });
    expect(missing.failure.kind === 'invalid-arguments' && missing.failure.issues).toEqual([
      'text: Invalid input: expected string, received undefined',
    ]);

    const badRef = parseToolInput('click', { ref: 'button 3' });
    expect(badRef.ok === false && badRef.failure.kind === 'invalid-arguments' && badRef.failure.issues).toEqual([
      'ref: must be a ref from the latest digest, like "e12"',
    ]);

    for (const url of ['fakegym.com/login', 'ftp://files.test/x', 'javascript:alert(1)', '']) {
      const parsed = parseToolInput('navigate', { url });
      expect(parsed.ok === false && parsed.failure.kind === 'invalid-arguments' && parsed.failure.issues).toEqual([
        'url: must be an absolute http(s) URL, scheme included',
      ]);
    }

    const notAnObject = parseToolInput('read', 'now');
    expect(notAnObject.ok === false && notAnObject.failure.kind === 'invalid-arguments' && notAnObject.failure.issues).toEqual([
      'Invalid input: expected object, received string',
    ]);

    const blank = parseToolInput('declare_outcome', { status: 'done', detail: '   ' });
    expect(blank.ok === false && blank.failure.kind === 'invalid-arguments' && blank.failure.issues).toEqual([
      'status: Invalid option: expected one of "succeeded"|"failed"|"blocked"',
      'detail: Too small: expected string to have >=1 characters',
    ]);
  });
});

describe('describeToolFailure', () => {
  const cases: readonly [ToolFailure, string][] = [
    [{ kind: 'unknown-tool', tool: 'scroll' }, 'There is no tool named "scroll". The tools are: navigate, click, type, select, read, ask_user, declare_outcome.'],
    [
      { kind: 'invalid-arguments', tool: 'type', issues: ['text: missing', 'ref: odd'] },
      'The arguments to type do not fit its schema: text: missing; ref: odd. Fix them and call again.',
    ],
    [{ kind: 'stale-ref', ref: 'e9', reason: 'unknown' }, 'Ref e9 is not from any digest of this page. Call read and use a ref from the fresh digest.'],
    [
      { kind: 'stale-ref', ref: 'e9', reason: 'missing' },
      'Ref e9 is no longer on the page: it navigated or changed since that digest. Call read and use a ref from the fresh digest.',
    ],
    [
      { kind: 'stale-ref', ref: 'e9', reason: 'changed' },
      'The element at e9 is not what it was when the digest was taken. Call read and use a ref from the fresh digest.',
    ],
    [{ kind: 'not-interactable', ref: 'e2', reason: '"Locked" is disabled' }, 'Cannot act on e2: "Locked" is disabled.'],
    [
      { kind: 'no-such-option', ref: 'e3', option: 'weekly', options: ['Monthly', 'Annual'] },
      'e3 has no option "weekly". Its options are: "Monthly", "Annual".',
    ],
    [
      { kind: 'navigation-failed', url: 'http://127.0.0.1:9/', reason: 'net::ERR_CONNECTION_REFUSED at http://127.0.0.1:9/' },
      'Could not open http://127.0.0.1:9/: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:9/.',
    ],
    [
      { kind: 'timeout', tool: 'click', reason: 'Timeout 1500ms exceeded' },
      'click timed out: Timeout 1500ms exceeded. The page may be busy or the element covered; read it again before retrying.',
    ],
    [
      { kind: 'timeout', tool: 'navigate', reason: 'Timeout 30000ms exceeded' },
      'navigate timed out: Timeout 30000ms exceeded. The page did not finish loading in time; try again, or declare the outcome if it keeps stalling.',
    ],
    [
      {
        kind: 'guardrail',
        reason: "navigation to http://localhost:1/x is outside the task's allowlist",
        stop: {
          kind: 'allowlist',
          attemptedUrl: 'http://localhost:1/x',
          via: 'navigation',
          redirectedFrom: undefined,
          from: 'http://127.0.0.1:1/',
          reason: 'host',
        },
      },
      "The guardrails stopped the browser: navigation to http://localhost:1/x is outside the task's allowlist. The browser session has ended and no further page action is possible; declare the outcome honestly.",
    ],
    [{ kind: 'page-error', tool: 'read', reason: 'the page is closed' }, 'read failed: the page is closed.'],
  ];

  it.each(cases)('has words for %j', (failure, expected) => {
    expect(describeToolFailure(failure)).toBe(expected);
  });
});

describe('trailDetail', () => {
  const digest: PageDigest = {
    url: 'http://127.0.0.1:1/',
    title: 'Home',
    elements: [{ ref: 'e1', kind: 'link', label: 'Go', href: 'http://127.0.0.1:1/go' }],
    regions: [{ role: 'heading', text: 'Home' }],
    truncation: { elementsOmitted: 2, regionsOmitted: 0, clipped: false },
  };

  it('keeps counts of a digest rather than the digest', () => {
    const execution: ToolExecution = { kind: 'ok', tool: 'read', result: { kind: 'digest', digest }, text: '' };
    expect(trailDetail(execution)).toEqual({
      result: {
        kind: 'digest',
        url: 'http://127.0.0.1:1/',
        title: 'Home',
        elements: 1,
        regions: 1,
        truncation: { elementsOmitted: 2, regionsOmitted: 0, clipped: false },
      },
    });
  });

  it('keeps a field result, a failure, a question and a declared outcome whole', () => {
    const field: ToolExecution = {
      kind: 'ok',
      tool: 'type',
      result: { kind: 'field', page: { url: 'u', title: 't' }, ref: 'e2', value: 'x' },
      text: '',
    };
    expect(trailDetail(field)).toEqual({
      result: { kind: 'field', page: { url: 'u', title: 't' }, ref: 'e2', value: 'x' },
    });
    expect(
      trailDetail({ kind: 'error', tool: 'scroll', failure: { kind: 'unknown-tool', tool: 'scroll' }, text: '' }),
    ).toEqual({ failure: { kind: 'unknown-tool', tool: 'scroll' } });
    expect(trailDetail({ kind: 'ask', question: 'Code?', text: '' })).toEqual({ question: 'Code?' });
    expect(trailDetail({ kind: 'outcome', status: 'failed', detail: 'no', text: '' })).toEqual({
      status: 'failed',
      detail: 'no',
    });
  });
});
