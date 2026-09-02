#!/usr/bin/env node
// Runs the job worker against DATABASE_URL. Documented as `pnpm worker`.
//
// The process is TypeScript, so this builds the watch and playbooks packages
// - and through their project references the agent, core, db and solari
// packages - before importing them, for the same reason `pnpm migrate` does:
// a documented command has to work from a fresh clone without anyone knowing
// to build first. The build is incremental, so repeat runs are almost free.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { shutdownOn } from './shutdown.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

const build = spawn(
  process.execPath,
  ['node_modules/typescript/bin/tsc', '--build', 'packages/watch', 'packages/playbooks'],
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

  const [agent, db, playbooks, solari, watch] = await Promise.all([
    import('../packages/agent/dist/index.js'),
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
  // No playbook is registered yet - the fakegym cancellation is the first -
  // so until one is, every task is refused in a sentence rather than run.
  // A question for a person is one JSON line on stdout, like the events.
  const registry = playbooks.createPlaybookRegistry([]);
  const mission = playbooks.createPlaybookMission({ db: database.db, provider, registry });

  let worker;
  try {
    worker = await db.startWorker({ connectionString }, [
      watch.registerWatchEngine({ db: database, ladder, creator, notifier }),
      db.registerTaskEngine({ db: database.db, mission, userIO: db.createLogUserIO() }),
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
