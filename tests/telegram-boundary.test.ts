import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The `bot-io-runtime` invariant, made to fail rather than trusted: exactly one
 * module in the workspace calls Telegram. A second one would not break a test —
 * it would quietly open a second door a message can arrive at or leave by
 * without being transcribed, and the transcript's completeness rests entirely
 * on there being one of each.
 */

const SOURCE_ROOTS = ['packages', 'fixtures', 'scripts', 'tests'];
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

/** The single module allowed to call grammY, relative to the repository root. */
const THE_ONE_MODULE = 'packages/bot/src/runtime.ts';

/**
 * The test transport may name grammY without being a second door: it takes only
 * types, which are erased before anything runs, and it exists to answer calls
 * rather than make them.
 */
const TYPES_ONLY = ['packages/bot/src/testing/transport.ts'];

function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(join(repositoryRoot, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      // `dist` is emitted from these same sources and `node_modules` is grammY
      // itself; neither is workspace code that could open a second door.
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      sourceFiles(path, found);
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.mjs')) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Every `import ... from 'grammy...'` in a file, and whether it is type-only.
 *
 * Deliberately not line-anchored. A grammY import wide enough for the formatter
 * to break across lines is exactly the shape a growing importer takes, and a
 * scanner that could not see one would stop enforcing this invariant without
 * failing — which is the one way a drift proof is worse than no drift proof.
 */
function grammyImports(source: string): { statement: string; typeOnly: boolean }[] {
  // `[^;]` spans newlines but cannot cross the semicolon ending the previous
  // statement, which is what keeps a multi-line match from starting at an
  // earlier import and reporting that one's `type` keyword as this one's.
  const statements = /^import (type )?[^;]*?from '(grammy[\w/-]*)';$/gmu;
  return [...source.matchAll(statements)].map((match) => ({
    statement: match[0],
    // Only the leading `import type` erases the whole statement. Inline `type`
    // specifiers inside a value import do not: the statement still runs.
    typeOnly: match[1] === 'type ',
  }));
}

const modules = SOURCE_ROOTS.flatMap((root) => sourceFiles(root))
  .map((path) => ({ path, imports: grammyImports(readFileSync(join(repositoryRoot, path), 'utf8')) }))
  .filter(({ imports }) => imports.length > 0);

/**
 * The scanner above is the whole enforcement, so it is worth its own proof: a
 * scanner that silently matched nothing would leave every assertion below
 * passing against an empty list.
 */
describe('the scanner the boundary is enforced with', () => {
  it('sees an import the formatter has broken across lines', () => {
    const broken = ['import {', '  Bot,', '  GrammyError,', "} from 'grammy';"];
    // Preceded by a type-only import of something else, which is the shape that
    // fooled the line-anchored scanner this replaced: it matched from that
    // statement's `type` keyword all the way to this one's closing quote.
    const source = ["import type { IncomingMessage } from 'node:http';", '', ...broken].join('\n');

    expect(grammyImports(source)).toEqual([{ statement: broken.join('\n'), typeOnly: false }]);
  });

  it('still tells a type-only import from a value one', () => {
    const typeOnly = "import type { Transformer } from 'grammy';";
    const value = "import { Bot } from 'grammy';";

    expect(grammyImports(typeOnly)[0]?.typeOnly).toBe(true);
    expect(grammyImports(value)[0]?.typeOnly).toBe(false);
  });

  it('ignores imports from anywhere else', () => {
    expect(grammyImports("import { z } from 'zod';")).toEqual([]);
  });
});

describe('the Telegram boundary', () => {
  it('is one module, and it is the runtime', () => {
    const callers = modules
      .filter(({ imports }) => imports.some((line) => !line.typeOnly))
      .map(({ path }) => path);

    expect(callers).toEqual([THE_ONE_MODULE]);
  });

  it('lets nothing else so much as name grammY, beyond the test transport', () => {
    expect(modules.map(({ path }) => path).sort()).toEqual([THE_ONE_MODULE, ...TYPES_ONLY].sort());
  });

  it('keeps the test transport to types, so it cannot call Telegram either', () => {
    for (const path of TYPES_ONLY) {
      const found = modules.find((module) => module.path === path);

      // Both halves matter: the file still imports grammY, and every one of
      // those imports is erased. A file that stopped importing it entirely
      // would pass a weaker assertion for the wrong reason.
      expect(found?.imports.length, path).toBeGreaterThan(0);
      for (const line of found?.imports ?? []) {
        expect(line.typeOnly, line.statement).toBe(true);
      }
    }
  });
});
