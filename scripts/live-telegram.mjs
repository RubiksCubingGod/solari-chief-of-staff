#!/usr/bin/env node
// The live Telegram round-trip, run deliberately.
//
// The suite itself skips unless TELEGRAM_LIVE_ROUNDTRIP opts in, which is what
// keeps `pnpm check` from messaging anyone. This script is the other side of
// that switch: it is how a person says yes on purpose, with a phone in hand.
//
// It refuses to run without the token and the chat rather than letting the
// suite skip, because a skipped suite exits zero and a proof that can pass
// without reaching a phone is not a proof. Since the script supplies the flag
// and both values, the guard cannot skip, so exit zero here means a real
// reminder arrived and a real yes came back.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Read `.env` the way the rest of the workspace expects it to be read: as the
 * local stand-in for a secret store. Anything already in the environment wins.
 */
function loadDotEnv() {
  let contents;
  try {
    contents = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  } catch {
    return; // No .env is fine when the values arrive as environment variables.
  }

  for (const line of contents.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    if (key === '' || process.env[key] !== undefined) continue;

    const raw = trimmed.slice(separator + 1).trim();
    const unquoted =
      (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
        ? raw.slice(1, -1)
        : raw;
    process.env[key] = unquoted;
  }
}

loadDotEnv();

const token = (process.env['TELEGRAM_BOT_TOKEN'] ?? '').trim();
const chatId = (process.env['TELEGRAM_LIVE_CHAT_ID'] ?? '').trim();
const missing = [token === '' ? 'TELEGRAM_BOT_TOKEN' : null, chatId === '' ? 'TELEGRAM_LIVE_CHAT_ID' : null].filter(
  (name) => name !== null,
);
if (missing.length > 0) {
  process.stderr.write(
    `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set. The live round-trip reaches a real phone, so it fails\n` +
      'here rather than skipping: a skipped suite exits zero and would report a live run that never happened.\n' +
      'Set both in .env: the token from @BotFather, and the id of the chat between the bot and the phone\n' +
      'that will answer (see .env.example for where to find it).\n',
  );
  process.exit(1);
}

process.stdout.write(
  'The live round-trip is starting. Keep the phone that talks to the bot in hand: it will get a reminder,\n' +
    'then a question to answer "yes" to, then a request for a confirmation code that this terminal prints.\n' +
    'Each answer has five minutes. Stop any `pnpm bot` on the same token first; Telegram allows one poller.\n\n',
);

const child = spawn(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    '--project',
    'integration',
    'tests/live-telegram.integration.test.ts',
  ],
  {
    cwd: repositoryRoot,
    shell: false,
    stdio: 'inherit',
    env: {
      ...process.env,
      TELEGRAM_BOT_TOKEN: token,
      TELEGRAM_LIVE_CHAT_ID: chatId,
      TELEGRAM_LIVE_ROUNDTRIP: '1',
    },
  },
);

child.once('error', (error) => {
  process.stderr.write(`vitest could not start: ${error.message}\n`);
  process.exit(1);
});

child.once('close', (code, signal) => {
  process.exit(signal === null ? (code ?? 1) : 1);
});
