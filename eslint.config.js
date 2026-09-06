import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/.next/**',
      '**/drizzle/**',
      // Written by Next on every dev and build run, and it references types
      // that only exist inside .next, so no TypeScript project can own it.
      '**/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        // One config covers every linted TypeScript file: the per-package
        // build configs deliberately exclude tests, so the project service
        // would not find them. The dashboard is the exception - its pages are
        // JSX and need the DOM library, which the workspace-wide config
        // deliberately does not hand to server packages - so it brings its own.
        project: ['./tsconfig.test.json', './packages/web/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['packages/web/**/*.ts', 'packages/web/**/*.tsx'],
    rules: {
      // ARCHITECTURE has the dashboard reading everything it draws from the
      // HTTP API. Nothing stops a page from opening a pool of its own except
      // this rule, and a boundary nobody enforces is a boundary that is already
      // gone: the second door would come with its own row shapes, its own
      // authorisation story, and no route to test them at.
      //
      // `packages/web/src/api-boundary.test.ts` lints synthetic source through
      // this configuration and requires the refusal.
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@chief-of-staff/db',
                '@chief-of-staff/db/*',
                'drizzle-orm',
                'drizzle-orm/*',
                'pg',
                'pg/*',
              ],
              // Type imports included: erasing at runtime opens no connection,
              // but it still couples the dashboard to the schema rather than to
              // what the API answers with, which is the coupling that matters.
              allowTypeImports: false,
              message:
                'The dashboard reads its data over HTTP: the API is the only door. Add a route in packages/api and call it through the client in packages/web/src/api-client.ts.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
