import Anthropic from '@anthropic-ai/sdk';

/**
 * The one place a process builds the vendor client. The worker script lives
 * outside the workspace packages and cannot resolve the SDK on its own -
 * nothing is hoisted - so it asks this package for the client it hands to
 * `createExtractorCreator`. Nothing here reads the environment: the process
 * that owns the key passes it in, and tests keep passing their own client.
 */
export function createAnthropicClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey });
}
