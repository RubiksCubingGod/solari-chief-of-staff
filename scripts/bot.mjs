#!/usr/bin/env node
// Runs the Telegram bot against DATABASE_URL. Documented as `pnpm bot`.
//
// The one process that listens to Telegram. It long-polls for messages,
// writes every one of them to the transcript, redeems `/start <code>`
// bindings, and carries a reply from someone a task is waiting on back to
// that task - recording the answer beside the question and queueing the task
// to run again with it on the same pg-boss schema `pnpm worker` consumes.
// Telegram allows one poller per token, so this process is that one: the
// worker sends through the bot's door without listening.
//
// The process is TypeScript, so this builds the bot package - and through its
// project references the core and db packages - before importing it, for the
// same reason `pnpm migrate` does: a documented command has to work from a
// fresh clone without anyone knowing to build first. The build is incremental,
// so repeat runs are almost free.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { shutdownOn } from './shutdown.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * What an ordinary message is answered with. The assistant is not on this
 * process yet: the chat tools call the API as the person who wrote, and what
 * a server-to-server caller presents for that is the open seam named in
 * packages/agent/src/crud.ts. Until it is decided, a message that is not an
 * answer gets this sentence rather than silence.
 */
const NOT_YET_THE_ASSISTANT =
  'I can carry your reply to a question one of your tasks has asked, and nothing else yet. For everything else, use the dashboard.';

const build = spawn(
  process.execPath,
  ['node_modules/typescript/bin/tsc', '--build', 'packages/bot'],
  { cwd: repositoryRoot, shell: false, stdio: 'inherit' },
);

build.once('error', (error) => {
  process.stderr.write(`bot: could not build the bot package: ${error.message}\n`);
  process.exit(1);
});

build.once('close', (code) => {
  if (code !== 0) {
    process.stderr.write('bot: the bot package did not build\n');
    process.exit(code ?? 1);
  }
  void run();
});

async function run() {
  const [bot, db] = await Promise.all([
    import('../packages/bot/dist/index.js'),
    import('../packages/db/dist/index.js'),
  ]);

  let config;
  try {
    config = bot.loadBotConfig();
  } catch (error) {
    if (error instanceof bot.BotConfigError) {
      for (const problem of error.problems) process.stderr.write(`bot: ${problem}\n`);
    } else {
      process.stderr.write(`bot: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exit(1);
    return;
  }
  if (config.transport !== 'polling') {
    // The runtime can serve a webhook, but nothing here mounts its handler on
    // a listener yet; refusing is better than a process that registers a URL
    // with Telegram and then answers nothing at it.
    process.stderr.write(
      `bot: TELEGRAM_TRANSPORT is ${config.transport}, and this process only long-polls; set it to polling\n`,
    );
    process.exit(1);
    return;
  }

  const database = db.createDatabase(config.databaseUrl);
  // The same schema the worker consumes from, so an answered task runs there.
  const harness = db.createJobHarness({ connectionString: config.databaseUrl });
  let runtime;
  try {
    await harness.start();
    runtime = bot.createBotRuntime({
      config,
      db: database.db,
      harness,
      chatLoop: { respond: () => Promise.resolve(NOT_YET_THE_ASSISTANT) },
    });
    await runtime.start();
  } catch (error) {
    process.stderr.write(`bot: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
    return;
  }
  // Registered before the process announces itself, for the reason spelled out
  // in scripts/server.mjs: a SIGTERM that lands between the announcement and
  // the handler kills the process, and here that abandons an update mid-route.
  shutdownOn(['SIGTERM', 'SIGINT'], async () => {
    await runtime.stop();
    await harness.stop();
    await database.close();
    process.stdout.write('bot: stopped\n');
  });
  process.stdout.write('bot: polling Telegram; the assistant is not on this process yet, replies to waiting tasks are carried\n');
}
