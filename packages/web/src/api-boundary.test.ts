import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * "The API is the only door" is an architectural claim, and a claim nobody
 * checks is a comment. This runs the repository's own ESLint configuration over
 * source text that never touches the disk, so the boundary is proven to refuse
 * a direct database import without leaving a violating file behind for
 * `eslint .` to trip over.
 */

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const BOUNDARY_RULE = '@typescript-eslint/no-restricted-imports';

/**
 * Two files that exist and that `tsconfig.test.json` already covers. ESLint
 * lints the text it is handed rather than what is on disk, but the path still
 * has to be one the type-aware configuration knows about - and it is the path
 * alone that decides whether the boundary applies.
 */
const WEB_FILE = join(repositoryRoot, 'packages', 'web', 'src', 'index.ts');
const API_FILE = join(repositoryRoot, 'packages', 'api', 'src', 'index.ts');

const eslint = new ESLint({ cwd: repositoryRoot });

async function boundaryMessages(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? [])
    .filter((message) => message.ruleId === BOUNDARY_RULE)
    .map((message) => message.message);
}

/**
 * Every specifier the boundary has to refuse, in the order they appear in the
 * synthetic source below - so a message's line number names the specifier that
 * produced it, and one lint run proves each of them individually.
 */
const FORBIDDEN_SPECIFIERS = [
  'drizzle-orm',
  'drizzle-orm/pg-core',
  'pg',
  '@chief-of-staff/db/testing',
] as const;

/**
 * Type-aware linting builds a TypeScript program over the whole workspace, and
 * under `pnpm check` it does that while the coverage-instrumented suite runs
 * around it. Seconds per call is the honest cost of linting through the real
 * configuration rather than a stub of it, so the budget belongs to the suite
 * rather than to one test: the first test does not reliably absorb the program
 * build on behalf of the rest.
 */
describe('the packages/web import boundary', () => {
  it('refuses a direct database import from web source', async () => {
    const messages = await boundaryMessages(
      "import { watches } from '@chief-of-staff/db';\nexport const probe = watches;\n",
      WEB_FILE,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/API is the only door/u);
  });

  it('refuses the driver and the query builder as well as the schema package', async () => {
    const imports = FORBIDDEN_SPECIFIERS.map(
      (specifier, index) => `import * as forbidden${index} from '${specifier}';`,
    ).join('\n');
    const uses = FORBIDDEN_SPECIFIERS.map((_, index) => `forbidden${index}`).join(', ');
    const source = `${imports}\nexport const probe = [${uses}];\n`;

    const [result] = await eslint.lintText(source, { filePath: WEB_FILE });
    const refusedLines = (result?.messages ?? [])
      .filter((message) => message.ruleId === BOUNDARY_RULE)
      .map((message) => message.line);

    // One refusal per import, each on its own line: asserting the lines rather
    // than just the count is what proves no single specifier slipped through
    // while its neighbours were caught.
    expect(refusedLines).toEqual(FORBIDDEN_SPECIFIERS.map((_, index) => index + 1));
  });

  it('closes the door to type-only imports too', async () => {
    // A type import is erased at runtime, so it opens no connection - but it
    // does couple the dashboard to the schema instead of to what the API
    // returns, which is the coupling this boundary exists to prevent.
    const messages = await boundaryMessages(
      "import type { Database } from '@chief-of-staff/db';\nexport type Probe = Database;\n",
      WEB_FILE,
    );

    expect(messages).toHaveLength(1);
  });

  it('leaves ordinary web imports alone', async () => {
    const messages = await boundaryMessages(
      "import { randomUUID } from 'node:crypto';\nexport const probe = randomUUID();\n",
      WEB_FILE,
    );

    expect(messages).toEqual([]);
  });

  it('applies to web and not to the packages that are meant to hold the database', async () => {
    const messages = await boundaryMessages(
      "import { watches } from '@chief-of-staff/db';\nexport const probe = watches;\n",
      API_FILE,
    );

    expect(messages).toEqual([]);
  });
}, 180_000);
