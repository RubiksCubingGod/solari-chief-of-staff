import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import { DEFAULT_MODEL_RETRY, apiTool, classifyModelError, replayable, retryDelayMs } from './model.js';
import { BROWSER_TOOLS } from './tools.js';

describe('retryDelayMs', () => {
  it('doubles from the base with every failed attempt', () => {
    expect(retryDelayMs(DEFAULT_MODEL_RETRY, 1)).toBe(500);
    expect(retryDelayMs(DEFAULT_MODEL_RETRY, 2)).toBe(1_000);
    expect(retryDelayMs(DEFAULT_MODEL_RETRY, 3)).toBe(2_000);
    expect(retryDelayMs({ attempts: 2, baseDelayMs: 100 }, 0)).toBe(100);
  });
});

describe('classifyModelError', () => {
  const apiError = (status: number | undefined, message: string): unknown =>
    new Anthropic.APIError(status, undefined, message, undefined);

  it('retries an outage, a rate limit, a timeout, a conflict, and a dropped connection', () => {
    for (const status of [500, 502, 529, 429, 408, 409]) {
      expect(classifyModelError(apiError(status, 'later'))).toEqual({
        kind: 'failed',
        retryable: true,
        status,
        message: `${String(status)} later`,
      });
    }
    const dropped = classifyModelError(new Anthropic.APIConnectionError({ message: 'socket hang up' }));
    expect(dropped).toMatchObject({ kind: 'failed', retryable: true, status: undefined });
  });

  it('does not retry a request the API rejected', () => {
    for (const status of [400, 401, 403, 404, 413]) {
      expect(classifyModelError(apiError(status, 'no'))).toMatchObject({ retryable: false, status });
    }
  });

  it('does not retry anything that is not an API error, and keeps its words', () => {
    expect(classifyModelError(new Error('boom'))).toEqual({
      kind: 'failed',
      retryable: false,
      status: undefined,
      message: 'boom',
    });
    expect(classifyModelError('bare')).toEqual({ kind: 'failed', retryable: false, status: undefined, message: 'bare' });
  });
});

describe('apiTool', () => {
  it('hands the API each browser tool under its own name, description and object schema', () => {
    const tools = BROWSER_TOOLS.map(apiTool);
    expect(tools.map((tool) => tool.name)).toEqual(BROWSER_TOOLS.map((tool) => tool.name));
    for (const tool of tools) {
      expect(tool.description).not.toBe('');
      expect(tool.input_schema.type).toBe('object');
      expect(tool.input_schema['properties']).toBeDefined();
    }
  });
});

describe('replayable', () => {
  it('keeps text and tool uses in order and drops what the API would not take back', () => {
    const blocks = replayable([
      { type: 'text', text: 'first', citations: null },
      { type: 'thinking', thinking: 'hmm', signature: 'sig' },
      { type: 'tool_use', id: 'toolu_1', name: 'read', input: {} },
    ]);
    expect(blocks).toEqual([
      { type: 'text', text: 'first' },
      { type: 'tool_use', id: 'toolu_1', name: 'read', input: {} },
    ]);
  });
});
