import Anthropic from '@anthropic-ai/sdk';
import {
  EXTRACTOR_SPEC_VERSION,
  describeReplayFailure,
  pageSnapshot,
  parseCondition,
  parseExtractorSpec,
  parserForKind,
  replayExtractor,
  type ExtractorSpec,
  type WatchKind,
  type WatchRecord,
  type WatchStore,
  type WatchValue,
} from '@chief-of-staff/core';

/**
 * Extractor creation: the one place the watch engine pays for a model.
 *
 * A watch is checked on a schedule for as long as it lives, and a check that
 * asked a model to read the page would cost tokens every time. So the model is
 * asked once, for a CSS selector, and what it proposes is replayed against the
 * very page it was shown before it is kept: a proposal that does not read the
 * value from the page it was made from will not read it from any other. Every
 * check after that is the replay engine in core, which costs nothing.
 *
 * The loop is a single forced tool call rather than a runner: there is one
 * question and one shape of answer, and a model that wants to reason may do so
 * in the rationale field.
 */

/** ARCHITECTURE §7: one model everywhere. */
export const EXTRACTOR_MODEL = 'claude-opus-5';

/** A selector, an attribute and a sentence: nothing here needs room to think out loud. */
export const EXTRACTOR_MAX_TOKENS = 1024;

export const PROPOSE_EXTRACTOR_TOOL = 'propose_extractor';

export const EXTRACTOR_SYSTEM_PROMPT = `You write one CSS selector that reads a watched value out of a web page, once, so that a program can read it again on every later visit without you.

You are shown a cleaned snapshot of the page. Answer only by calling ${PROPOSE_EXTRACTOR_TOOL}.

What makes a selector worth keeping:
- It matches exactly the element that holds the value, and nothing else.
- It survives a redesign. Prefer stable hooks - data-* attributes, ids, aria-label, itemprop, the page's semantic structure - over class names, which are generated or renamed with every theme.
- It reads the value where it is cleanest. Set attribute to read an attribute, such as a <meta> tag's content, instead of the element's text.`;

const PROPOSAL_TOOL: Anthropic.Tool = {
  name: PROPOSE_EXTRACTOR_TOOL,
  description:
    'Propose the CSS selector that reads the watched value out of this page. Called exactly once; ' +
    'the proposal is tested against the page before it is kept.',
  input_schema: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        description: 'A CSS selector matching exactly the element that holds the value.',
      },
      attribute: {
        type: ['string', 'null'],
        description:
          'Read this attribute of the matched element instead of its text, e.g. "content" for a <meta> tag. ' +
          'Null to read the text.',
      },
      rationale: {
        type: 'string',
        description: 'One sentence on why this selector will survive a redesign.',
      },
    },
    required: ['selector'],
  },
};

export const EXTRACTOR_FAILURES = ['unsupported-kind', 'unavailable', 'no-proposal', 'invalid-spec', 'replay-failed'] as const;
export type ExtractorFailure = (typeof EXTRACTOR_FAILURES)[number];

export interface ExtractorRequest {
  readonly url: string;
  readonly kind: WatchKind;
  /** The page as fetched; it is reduced to a snapshot before the model sees it. */
  readonly html: string;
  /** What the person said they were watching, when they said anything. */
  readonly hint?: string | null;
}

export type ExtractorCreation =
  | {
      readonly ok: true;
      readonly spec: ExtractorSpec;
      /** What the spec read from the page it was created from. */
      readonly value: WatchValue;
      readonly rationale: string | null;
    }
  | { readonly ok: false; readonly failure: ExtractorFailure; readonly reason: string };

export interface ExtractorCreator {
  create(request: ExtractorRequest): Promise<ExtractorCreation>;
}

export interface ExtractorCreatorOptions {
  readonly client: Anthropic;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly snapshotChars?: number;
}

export function createExtractorCreator(options: ExtractorCreatorOptions): ExtractorCreator {
  const { client } = options;
  const model = options.model ?? EXTRACTOR_MODEL;
  const maxTokens = options.maxTokens ?? EXTRACTOR_MAX_TOKENS;

  return {
    async create(request) {
      const parse = parserForKind(request.kind);
      if (parse === undefined) {
        return {
          ok: false,
          failure: 'unsupported-kind',
          reason: `no extractor parser exists for ${request.kind} watches`,
        };
      }

      const snapshot =
        options.snapshotChars === undefined
          ? pageSnapshot(request.html)
          : pageSnapshot(request.html, options.snapshotChars);
      const content = [
        `Page: ${request.url}`,
        `Read: ${describeTarget(request.kind, request.hint ?? null)}`,
        '',
        'Snapshot (scripts, styles and comments removed, whitespace collapsed):',
        snapshot,
      ].join('\n');

      let message: Anthropic.Message;
      try {
        message = await client.messages.create({
          model,
          max_tokens: maxTokens,
          system: EXTRACTOR_SYSTEM_PROMPT,
          tools: [PROPOSAL_TOOL],
          tool_choice: { type: 'tool', name: PROPOSE_EXTRACTOR_TOOL },
          messages: [{ role: 'user', content }],
        });
      } catch (error: unknown) {
        return { ok: false, failure: 'unavailable', reason: describeApiFailure(error) };
      }

      const proposal = message.content.find(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === PROPOSE_EXTRACTOR_TOOL,
      );
      if (proposal === undefined) {
        const said = message.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
          .trim();
        const bare = 'the model answered without proposing an extractor';
        return { ok: false, failure: 'no-proposal', reason: said === '' ? bare : `${bare}: ${said}` };
      }

      const input = isRecord(proposal.input) ? proposal.input : {};
      const spec = parseExtractorSpec({
        version: EXTRACTOR_SPEC_VERSION,
        strategy: 'css',
        selector: input['selector'],
        attribute: input['attribute'] ?? null,
        parse,
      });
      if (spec === undefined) {
        return {
          ok: false,
          failure: 'invalid-spec',
          reason: `the proposal was not a usable spec: ${JSON.stringify(input)}`,
        };
      }

      const replay = replayExtractor(spec, request.html);
      if (!replay.ok) {
        return {
          ok: false,
          failure: 'replay-failed',
          reason: `${spec.selector} did not replay against the page it was created from: ${describeReplayFailure(replay)}`,
        };
      }

      return {
        ok: true,
        spec,
        value: replay.value,
        rationale: typeof input['rationale'] === 'string' ? input['rationale'] : null,
      };
    },
  };
}

export function describeCreationFailure(creation: ExtractorCreation & { readonly ok: false }): string {
  return `${creation.failure}: ${creation.reason}`;
}

export type ExtractorSubject = Pick<WatchRecord, 'id' | 'url' | 'kind' | 'condition'>;

/**
 * Create for a persisted watch and write down what happened. A validated spec
 * is stored and the watch is healthy; anything else leaves the watch in
 * `needs_extractor` with the reason where a person will see it, and stores
 * nothing - a spec that has not replayed is not a spec.
 */
export async function provisionExtractor(
  creator: ExtractorCreator,
  store: Pick<WatchStore, 'updateWatch'>,
  watch: ExtractorSubject,
  html: string,
): Promise<ExtractorCreation> {
  const creation = await creator.create({ url: watch.url, kind: watch.kind, html, hint: regionHint(watch) });
  if (creation.ok) {
    await store.updateWatch(watch.id, { extractor: creation.spec, health: 'healthy', lastError: null });
  } else {
    await store.updateWatch(watch.id, { health: 'needs_extractor', lastError: describeCreationFailure(creation) });
  }
  return creation;
}

function describeTarget(kind: WatchKind, hint: string | null): string {
  if (kind === 'price') {
    return "the product's current price - the one a buyer would pay now, not a struck-through or previous price";
  }
  if (hint !== null && hint.trim() !== '') {
    return `the region to watch for changes. The user described it as: ${hint.trim()}`;
  }
  return 'the region to watch for changes: the main content, leaving out navigation, footers and anything that changes on every visit';
}

/** A change watch may carry the person's description of the region; nothing else has one. */
function regionHint(watch: ExtractorSubject): string | null {
  const condition = parseCondition(watch.kind, watch.condition);
  return condition?.kind === 'change' ? condition.region : null;
}

function describeApiFailure(error: unknown): string {
  if (error instanceof Anthropic.APIError) return `the API answered ${String(error.status)}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
