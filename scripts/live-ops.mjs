#!/usr/bin/env node
// The nightly live-ops gate, run deliberately.
//
// One case per class the release counts: the real browser session's lifecycle
// (the live smoke), the real-site watch checks, one fixture-target mission
// through the production engine, and the live eval suite. Each is a child
// process whose exit code is its outcome - zero passed, one failed, anything
// else errored: a signal, a timeout, a process that could not start, or a
// harness that stopped before it could say. The two red words are never
// merged, because a failure is a regression and an error is an outage, and
// a person on a red morning has to know which one they are chasing.
//
// The arithmetic - the night's colour, the cost against target, the count
// of green nights in a row - lives in packages/watch/src/live-ops so it can
// be proved for free. This script only runs the cases, feeds the results
// through it, writes the report the workflow uploads, and sends a night
// that is not green through the product's own door to the person on call.
//
// It refuses to run without both keys rather than letting the suites skip,
// for the reason the other live scripts do: a skipped suite exits zero, and
// a night that proved nothing must never be reported green.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

/** `.env` as the local stand-in for CI's secret store; the environment wins. */
function loadDotEnv() {
  let contents;
  try {
    contents = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  } catch {
    return;
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

function required(name) {
  const value = (process.env[name] ?? '').trim();
  if (value === '') {
    process.stderr.write(
      `${name} is not set. The live-ops night calls the real vendors, so this fails here rather than\n` +
        'skipping: a skipped suite exits zero and would report a night that never happened.\n' +
        'Set it in .env locally, or as a repository secret in CI.\n',
    );
    process.exit(1);
  }
  return value;
}

const solariKey = required('SOLARI_API_KEY');
const anthropicKey = required('ANTHROPIC_API_KEY');

const costTargetRaw = (process.env['LIVE_OPS_COST_TARGET_USD'] ?? '').trim();
const costTargetUsd = costTargetRaw === '' ? 5 : Number(costTargetRaw);
if (!Number.isFinite(costTargetUsd) || costTargetUsd < 0) {
  process.stderr.write(`LIVE_OPS_COST_TARGET_USD is ${JSON.stringify(costTargetRaw)}, not a number of dollars\n`);
  process.exit(1);
}

const reportDir = join(repositoryRoot, (process.env['LIVE_OPS_REPORT_DIR'] ?? '').trim() || 'live-ops');
const recordPath = join(reportDir, 'nights.json');
const date = (process.env['LIVE_OPS_DATE'] ?? '').trim() || new Date().toISOString().slice(0, 10);
const watchSuite = (process.env['LIVE_OPS_WATCH_SUITE'] ?? '').trim();
const CASE_TIMEOUT_MS = 45 * 60 * 1000;
const NO_COST = { solariUsd: 0, anthropicUsd: 0 };

/** The Anthropic spend the eval suite metered itself, read back from its report. */
function evalCost() {
  const report = join(reportDir, 'evals', 'report.txt');
  if (!existsSync(report)) return NO_COST;
  const match = /spent \$([\d.]+) of the/u.exec(readFileSync(report, 'utf8'));
  return match === null ? NO_COST : { solariUsd: 0, anthropicUsd: Number(match[1]) };
}

/**
 * One case per class. A case with nothing to run is reported errored with
 * the reason, never skipped: the night cannot be green until every class has
 * something real behind it. Solari cost is not metered per case yet, which
 * the release checklist's cost review is there to catch against the bill.
 */
const CASES = [
  { id: 'session-lifecycle', class: 'session', argv: ['scripts/live-smoke.mjs'] },
  {
    id: 'watch-checks',
    class: 'watch',
    argv: watchSuite === '' ? undefined : ['scripts/vitest.mjs', 'run', '--project', 'integration', watchSuite],
    cannotRun: 'LIVE_OPS_WATCH_SUITE names no real-site watch suite; onboard a site first',
  },
  {
    id: 'fixture-mission',
    class: 'mission',
    argv: ['scripts/live-llm.mjs', 'packages/playbooks/src/agentic-mission.integration.test.ts'],
  },
  {
    id: 'eval-suite',
    class: 'eval',
    argv: ['scripts/live-llm.mjs', 'packages/playbooks/src/agentic/eval/live.integration.test.ts'],
    env: { LIVE_EVAL_REPORT_DIR: join(reportDir, 'evals') },
    cost: evalCost,
  },
];

const lastLine = (text) => {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '');
  return (lines.at(-1) ?? '').slice(0, 200);
};

/** Runs one case to its outcome. Never throws: a case that cannot run is an errored result. */
function runCase(spec) {
  if (spec.argv === undefined) {
    return Promise.resolve({ id: spec.id, class: spec.class, outcome: 'errored', detail: spec.cannotRun, cost: NO_COST });
  }
  return new Promise((resolve) => {
    process.stdout.write(`\nlive-ops: ${spec.class} case ${spec.id}: node ${spec.argv.join(' ')}\n`);
    let output = '';
    const child = spawn(process.execPath, spec.argv, {
      cwd: repositoryRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(spec.env ?? {}), SOLARI_API_KEY: solariKey, ANTHROPIC_API_KEY: anthropicKey },
    });
    const capture = (stream, sink) => {
      stream.on('data', (chunk) => {
        sink.write(chunk);
        output = `${output}${String(chunk)}`.slice(-4000);
      });
    };
    capture(child.stdout, process.stdout);
    capture(child.stderr, process.stderr);
    const settle = (outcome, detail) =>
      resolve({ id: spec.id, class: spec.class, outcome, detail, cost: spec.cost?.() ?? NO_COST });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      settle('errored', `stopped after ${String(CASE_TIMEOUT_MS / 60000)} minutes`);
    }, CASE_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      settle('errored', `could not start: ${error.message}`);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal !== null) settle('errored', `stopped by ${signal}`);
      else if (code === 0) settle('passed', lastLine(output) || 'ok');
      else if (code === 1) settle('failed', lastLine(output) || 'exited 1');
      else settle('errored', `exited ${String(code)}: ${lastLine(output)}`);
    });
  });
}

/** The arithmetic lives in the watch package; build what it needs, as the worker does. */
function build() {
  return new Promise((resolve) => {
    const tsc = spawn(
      process.execPath,
      ['node_modules/typescript/bin/tsc', '--build', 'packages/watch', 'packages/bot'],
      { cwd: repositoryRoot, stdio: 'inherit' },
    );
    tsc.once('error', (error) => {
      process.stderr.write(`live-ops: could not build the packages: ${error.message}\n`);
      process.exit(1);
    });
    tsc.once('close', (code) => {
      if (code !== 0) {
        process.stderr.write('live-ops: the packages did not build\n');
        process.exit(code ?? 1);
      }
      resolve();
    });
  });
}

const ANNOTATION = { passed: 'notice', failed: 'error', errored: 'warning' };

async function notify(night, watch) {
  const databaseUrl = (process.env['DATABASE_URL'] ?? '').trim();
  const opsUserId = (process.env['OPS_USER_ID'] ?? '').trim();
  const token = (process.env['TELEGRAM_BOT_TOKEN'] ?? '').trim();
  if (databaseUrl === '' || opsUserId === '' || token === '') {
    process.stdout.write('live-ops: DATABASE_URL, TELEGRAM_BOT_TOKEN and OPS_USER_ID are not all set; no notice is sent\n');
    return;
  }
  const [bot, db] = await Promise.all([
    import('../packages/bot/dist/index.js'),
    import('../packages/db/dist/index.js'),
  ]);
  const database = db.createDatabase(databaseUrl);
  try {
    const sendToUser = bot.createTelegramOutbound({ config: bot.loadBotConfig(), db: database.db });
    const server = process.env['GITHUB_SERVER_URL'];
    const repository = process.env['GITHUB_REPOSITORY'];
    const runId = process.env['GITHUB_RUN_ID'];
    const runUrl =
      server !== undefined && repository !== undefined && runId !== undefined
        ? `${server}/${repository}/actions/runs/${runId}`
        : undefined;
    const notice = await bot.notifyOpsOfNight(sendToUser, opsUserId, night, runUrl === undefined ? {} : { runUrl });
    process.stdout.write(
      notice.sent ? `live-ops: sent the night to ${opsUserId} (${notice.delivery.status})\n` : `live-ops: ${notice.reason}\n`,
    );
  } finally {
    await database.close();
  }
  void watch;
}

await build();
const watch = await import('../packages/watch/dist/index.js');

const results = [];
for (const spec of CASES) results.push(await runCase(spec));

const night = watch.summarizeNight({ date, cases: results, costTargetUsd });
const record = watch.appendNight(
  existsSync(recordPath) ? watch.parseNightsRecord(readFileSync(recordPath, 'utf8')) : [],
  night,
);
const verdict = watch.judgeRecord(record);
const report = watch.renderNightReport(night, verdict);

mkdirSync(reportDir, { recursive: true });
writeFileSync(join(reportDir, 'night.json'), `${JSON.stringify(night, null, 2)}\n`);
writeFileSync(join(reportDir, 'night.md'), report);
writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
writeFileSync(join(reportDir, 'nights.md'), watch.renderNightsTable(record));

process.stdout.write(`\n${report}`);
for (const result of results) {
  process.stdout.write(`::${ANNOTATION[result.outcome]}::${result.class} case ${result.id} ${result.outcome}: ${result.detail}\n`);
}
const summaryPath = process.env['GITHUB_STEP_SUMMARY'];
if (summaryPath !== undefined && summaryPath !== '') writeFileSync(summaryPath, report, { flag: 'a' });

await notify(night, watch);
process.exit(night.colour === 'green' ? 0 : 1);
