import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The `solari-session-hygiene` invariant, made to fail rather than trusted.
 *
 * The spec does not merely observe that one module imports the vendor SDK, it
 * claims the boundary: "SolariProvider is the only code in the system that
 * imports @solarisdk/browser; no other module may touch the vendor SDK", and
 * "the import boundary is part of this spec's claim". Every sharp edge the
 * research turned up - close() versus release, the unconditional
 * isRetryableError, the dead GET /sessions/:id, the stealth prerequisites - is
 * encoded once, behind that boundary. A second importer would not break a test.
 * It would quietly acquire a session that the ledger never learns about, or
 * retry a 429 the adapter knows better than to retry, and the seam's promises
 * would still read as true.
 *
 * Nothing enforced this before: eslint.config.js restricts the db/drizzle/pg
 * group for the dashboard and nothing else. This is the missing half.
 */

const SOURCE_ROOTS = ['packages', 'fixtures', 'scripts', 'tests'];
const BUILD_OUTPUT = new Set(['node_modules', 'dist', '.next']);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

/** The single module allowed to import the vendor SDK, relative to the repository root. */
const THE_ONE_MODULE = 'packages/solari/src/solari.ts';

function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(join(repositoryRoot, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      // `dist` and `.next` are emitted from these same sources and
      // `node_modules` is the vendor SDK itself; none of it is workspace code
      // that could open a door. `.next` has to be skipped rather than merely
      // ignored: the dashboard's e2e suites each build into their own
      // `.next/instance-<uuid>` and delete it on the way out, so a scan that
      // walks in there is reading a directory that is being removed underneath
      // it, and fails with ENOENT on a file nobody wrote.
      if (BUILD_OUTPUT.has(entry.name)) continue;
      sourceFiles(path, found);
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.mjs')) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Every `import ... from '@solarisdk/...'` in a file.
 *
 * Deliberately not line-anchored, and deliberately blind to the difference
 * between a type import and a value one. The type distinction earns an
 * exception in the Telegram boundary because a type cannot place a call; here
 * it earns none, because the claim is about coupling rather than about calls.
 * A module that names the vendor's types is a module the vendor's next release
 * can break, which is the whole reason the sharp edges live in one place.
 */
function vendorImports(source: string): string[] {
  // `[^;]` spans newlines but cannot cross the semicolon ending the previous
  // statement, which is what keeps a multi-line match from starting at an
  // earlier import.
  const statements = /^import (?:type )?[^;]*?from '(?:@solarisdk\/[\w/-]*)';$/gmu;
  return [...source.matchAll(statements)].map((match) => match[0]);
}

function scanWorkspace(): { path: string; imports: string[] }[] {
  return SOURCE_ROOTS.flatMap((root) => sourceFiles(root))
    .map((path) => ({ path, imports: vendorImports(readFileSync(join(repositoryRoot, path), 'utf8')) }))
    .filter(({ imports }) => imports.length > 0);
}

/**
 * The scanner is the whole enforcement, so it gets its own proof: one that
 * silently matched nothing would leave every assertion below passing against an
 * empty list, which is the one way a drift proof is worse than none.
 */
describe('the scanner the vendor boundary is enforced with', () => {
  it('sees an import the formatter has broken across lines', () => {
    const broken = ['import {', '  Solari,', '  type BrowserSession,', "} from '@solarisdk/browser';"];
    // Preceded by a type-only import of something else, which is the shape that
    // defeats a line-anchored scanner.
    const source = ["import type { IncomingMessage } from 'node:http';", '', ...broken].join('\n');

    expect(vendorImports(source)).toEqual([broken.join('\n')]);
  });

  it('sees a type-only import too, because coupling is the thing being counted', () => {
    const typeOnly = "import type { BrowserSession } from '@solarisdk/browser';";

    expect(vendorImports(typeOnly)).toEqual([typeOnly]);
  });

  it('ignores imports from anywhere else, including near-misses', () => {
    expect(vendorImports("import { z } from 'zod';")).toEqual([]);
    expect(vendorImports("import { x } from './solarisdk-browser.js';")).toEqual([]);
  });
});

describe('the Solari vendor boundary', () => {
  it('is one module, and it is the adapter', () => {
    expect(scanWorkspace().map(({ path }) => path)).toEqual([THE_ONE_MODULE]);
  });

  it('fails the moment a second module reaches for the vendor SDK', () => {
    // The assertion above is only worth as much as its ability to fail. This
    // runs the same check over the same real scan plus one synthetic importer,
    // so the proof that it catches a violation costs no temporary edit to a
    // real file - and cannot pass by scanning nothing.
    const withViolator = [
      ...scanWorkspace(),
      { path: 'packages/agent/src/somewhere-else.ts', imports: ["import { Solari } from '@solarisdk/browser';"] },
    ];

    expect(withViolator.map(({ path }) => path)).not.toEqual([THE_ONE_MODULE]);
  });
});
