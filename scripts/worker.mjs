#!/usr/bin/env node
// Runs the job worker against DATABASE_URL. Documented as `pnpm worker`.
//
// The process is TypeScript, so this builds the watch, playbooks and bot
// packages - and through their project references the agent, core, db and
// solari packages - before importing them, for the same reason `pnpm migrate` does:
// a documented command has to work from a fresh clone without anyone knowing
// to build first. The build is incremental, so repeat runs are almost free.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { shutdownOn } from './shutdown.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

const build = spawn(
  process.execPath,
  [
    'node_modules/typescript/bin/tsc',
    '--build',
    'packages/watch',
    'packages/playbooks',
    'packages/bot',
  ],
  { cwd: repositoryRoot, shell: false, stdio: 'inherit' },
);

build.once('error', (error) => {
  process.stderr.write(`worker: could not build the worker's packages: ${error.message}\n`);
  process.exit(1);
});

build.once('close', (code) => {
  if (code !== 0) {
    process.stderr.write("worker: the worker's packages did not build\n");
    process.exit(code ?? 1);
  }
  void run();
});

async function run() {
  const connectionString = process.env['DATABASE_URL']?.trim();
  if (connectionString === undefined || connectionString === '') {
    process.stderr.write(
      'worker: DATABASE_URL is not set. Copy .env.example to .env and export it, or pass it inline.\n',
    );
    process.exit(1);
    return;
  }

  const [agent, bot, db, playbooks, solari, watch] = await Promise.all([
    import('../packages/agent/dist/index.js'),
    import('../packages/bot/dist/index.js'),
    import('../packages/db/dist/index.js'),
    import('../packages/playbooks/dist/index.js'),
    import('../packages/solari/dist/index.js'),
    import('../packages/watch/dist/index.js'),
  ]);

  const database = db.createDatabase(connectionString);
  // The browser tiers run on the pinned local Chromium, launched the first
  // time a check needs one. The hosted provider joins when its key is read
  // here.
  const provider = solari.createLocalProvider();
  const ladder = watch.createFetchLadder({ provider });
  const creator = extractorCreator(agent);
  // Every event is one JSON line on stdout until a delivery channel lands.
  const notifier = watch.createLogNotifier();
  // Every playbook-mode task goes through the runner, on the same provider.
  // Two playbooks so far - the fakegym cancellation and the fakedmv booking
  // a slot watch arms - each at the origin where its fixture listens on this
  // machine. Every other task is refused in a sentence rather than run. A
  // question for a person goes over Telegram when the bot's token is set,
  // and is one JSON line on stdout, like the events, when it is not.
  const registry = playbooks.createPlaybookRegistry([
    playbooks.fakegymCancellation({
      origin: process.env['FAKEGYM_URL']?.trim() || 'http://127.0.0.1:4303',
    }),
    playbooks.fakedmvBooking({
      origin: process.env['FAKEDMV_URL']?.trim() || 'http://127.0.0.1:4304',
    }),
  ]);
  // Behind the confirm gate: a task whose input carries a question - every
  // cancellation the calendar arms - runs only after a yes to it.
  const mission = db.withConfirmation(
    playbooks.createPlaybookMission({ db: database.db, provider, registry }),
  );
  // What a booking task's ending does to its watch - booked stays paused, a
  // slot that went or a person who passed re-arms, anything else waits for a
  // person - applied the moment this worker settles the task, and swept up
  // once a minute by the watch engine for a task a channel settled.
  const snipe = { db: database, notifier };
  const sendToUser = telegramOutbound(bot, database);

  let worker;
  try {
    worker = await db.startWorker({ connectionString }, [
      watch.registerWatchEngine({ db: database, ladder, creator, notifier }),
      db.registerTaskEngine({
        db: database.db,
        mission,
        userIO:
          sendToUser === undefined ? db.createLogUserIO() : bot.createTelegramUserIO(sendToUser),
        settled: (taskId) => watch.settleSnipe(snipe, taskId),
      }),
      ...calendarScan({ sendToUser, bot, db, playbooks, database, registry }),
    ]);
  } catch (error) {
    process.stderr.write(`worker: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
    return;
  }
  // Registered before the process announces itself, for the reason spelled out
  // in scripts/server.mjs: a SIGTERM that lands between the announcement and
  // the handler kills the process, and here that abandons a running check.
  shutdownOn(['SIGTERM', 'SIGINT'], async () => {
    await worker.stop();
    await provider.dispose();
    await database.close();
    process.stdout.write('worker: stopped\n');
  });
  process.stdout.write('worker: ready\n');
}

/**
 * The bot's outbound door, or nothing. Reminders and questions go out over
 * Telegram, so without the bot's token there is nowhere to send them: the
 * worker says so once at startup and runs everything else. With the token it
 * sends through the door without listening for updates - the bot process is
 * the one that polls, and Telegram allows only one.
 */
function telegramOutbound(bot, database) {
  const token = process.env['TELEGRAM_BOT_TOKEN']?.trim();
  if (token === undefined || token === '') {
    process.stderr.write(
      'worker: TELEGRAM_BOT_TOKEN is not set, so the calendar is not scanned and questions go to stdout; watches and tasks still run\n',
    );
    return undefined;
  }
  return bot.createTelegramOutbound({ config: bot.loadBotConfig(), db: database.db });
}

/**
 * The calendar scan, when there is a door to send through: reminders on
 * their lead day, and for a subscription flagged for it, a cancellation task
 * on the worker's own queue, behind the confirm gate. Without the door
 * neither happens, rather than every reminder being recorded as skipped and
 * every cancellation being armed with a question nobody would receive.
 */
function calendarScan({ sendToUser, bot, db, playbooks, database, registry }) {
  if (sendToUser === undefined) return [];
  return [
    db.registerCalendarScan({
      db: database.db,
      send: bot.createReminderSender(sendToUser),
      cancellations: playbooks.createCancellationPlanner({ db: database.db, registry }),
    }),
  ];
}

/**
 * The extractor writer, or its absence spelled out. Without a key the worker
 * still runs: watches that already have an extractor are checked as before,
 * and a watch that needs one is parked with this reason in its row, where
 * the person who can fix it will read it.
 */
function extractorCreator(agent) {
  const apiKey = process.env['ANTHROPIC_API_KEY']?.trim();
  if (apiKey !== undefined && apiKey !== '') {
    return agent.createExtractorCreator({ client: agent.createAnthropicClient(apiKey) });
  }
  process.stderr.write(
    'worker: ANTHROPIC_API_KEY is not set, so no extractor can be written; watches that already have one are still checked\n',
  );
  return {
    create: () =>
      Promise.resolve({
        ok: false,
        failure: 'unavailable',
        reason: 'ANTHROPIC_API_KEY is not set on the worker, so no extractor can be written',
      }),
  };
}
