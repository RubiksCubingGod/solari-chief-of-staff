/**
 * The Claude tool loops. The chat loop from ARCHITECTURE §6 is here; the action
 * loop and the extractor loop join it in later sprints.
 *
 * `MODULE_ID` predates all of them and is kept: importing it exercises the
 * workspace link, the package `exports` map and the build output, so a broken
 * toolchain fails a test rather than surfacing later as a resolution error.
 */
export const MODULE_ID = '@chief-of-staff/agent' as const;

export {
  CHAT_MAX_TOKENS,
  CHAT_MODEL,
  CHAT_SYSTEM_PROMPT,
  DEFAULT_TOOL_BUDGET,
  createChatAgent,
  type ChatAgent,
  type ChatAgentOptions,
  type ChatRequest,
  type ChatTurn,
  type ChatTurnOutcome,
} from './chat-agent.js';
export { createAnthropicClient } from './client.js';
export {
  createHttpCrudClient,
  type CrudClient,
  type CrudCredential,
  type CrudMethod,
  type CrudResponse,
  type HttpCrudClientOptions,
} from './crud.js';
export {
  EXTRACTOR_FAILURES,
  EXTRACTOR_MAX_TOKENS,
  EXTRACTOR_MODEL,
  PROPOSE_EXTRACTOR_TOOL,
  createExtractorCreator,
  describeCreationFailure,
  provisionExtractor,
  regionHint,
  type ExtractorCreation,
  type ExtractorCreator,
  type ExtractorCreatorOptions,
  type ExtractorFailure,
  type ExtractorRequest,
  type ExtractorSubject,
} from './extractor.js';
export {
  EXTRACTION_ROUTES,
  degradedDedupKey,
  extractWatchValue,
  type Extraction,
  type ExtractionPorts,
  type ExtractionRoute,
  type ExtractionSubject,
} from './healing.js';
export {
  ANTHROPIC_KEY_VARIABLE,
  LIVE_LLM_FLAG,
  liveLlmSkipReason,
} from './live-llm.js';
export {
  LLM_UNAVAILABLE,
  LLM_UNAVAILABLE_MIDWAY,
  NO_REPLY_PRODUCED,
  TOOL_BUDGET_SPENT,
} from './replies.js';
export {
  CHAT_TOOL_NAMES,
  createChatToolkit,
  type ChatToolName,
  type ChatToolkit,
  type ChatToolkitOptions,
  type ToolCallRecord,
} from './tools.js';
