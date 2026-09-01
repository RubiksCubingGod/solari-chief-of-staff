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

/** Every `... from 'grammy...'` line in a file, and whether it is type-only. */
function grammyImports(source: string): { statement: string; typeOnly: boolean }[] {
  return [...source.matchAll(/^import (type )?.*from '(grammy[\w/-]*)';$/gmu)].map((match) => ({
    statement: match[0],
    typeOnly: match[1] === 'type ',
  }));
}

const modules = SOURCE_ROOTS.flatMap((root) => sourceFiles(root))
  .map((path) => ({ path, imports: grammyImports(readFileSync(join(repositoryRoot, path), 'utf8')) }))
  .filter(({ imports }) => imports.length > 0);

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
