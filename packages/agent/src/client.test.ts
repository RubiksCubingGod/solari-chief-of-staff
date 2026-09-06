import { describe, expect, it } from 'vitest';

import { createAnthropicClient } from './client.js';

describe('createAnthropicClient', () => {
  it('builds a client that carries the key it was handed', () => {
    const client = createAnthropicClient('sk-ant-test-key');

    expect(client.apiKey).toBe('sk-ant-test-key');
  });
});
