import {
  CASE_CLASSES,
  CASE_OUTCOMES,
  judgeRecord,
  type CaseResult,
  type NightColour,
  type NightSummary,
  type RecordVerdict,
} from './verdict.js';

/**
 * The record the nights accumulate into, and the two renderings of it: the
 * report a night leaves behind for a person to read, and the table the
 * release checklist copies its lines from.
 *
 * The record is a JSON array of night summaries, oldest first, one per
 * date. It is an artifact the workflow uploads and a person carries into
 * `docs/RELEASE-CHECKLIST.md` by hand, never a file this code commits: the
 * three-night record is evidence a person vouches for, and a job that wrote
 * its own record into the repository would be vouching for itself.
 */

export type NightsRecord = readonly NightSummary[];

const COLOURS: readonly NightColour[] = ['green', 'failed', 'errored'];
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function fail(where: string, what: string): never {
  throw new Error(`the nights record is not a record: ${where} ${what}`);
}

function readCase(value: unknown, where: string): CaseResult {
  if (!isRecord(value)) fail(where, 'is not an object');
  const { id, outcome, detail, cost } = value;
  const kind = value['class'];
  if (typeof id !== 'string' || id === '') fail(where, 'has no id');
  if (!CASE_CLASSES.some((known) => known === kind)) fail(where, `has class ${JSON.stringify(kind)}`);
  if (!CASE_OUTCOMES.some((known) => known === outcome)) fail(where, `has outcome ${JSON.stringify(outcome)}`);
  if (typeof detail !== 'string') fail(where, 'has no detail');
  if (!isRecord(cost) || !isFinite(cost['solariUsd']) || !isFinite(cost['anthropicUsd'])) {
    fail(where, 'has no cost per vendor');
  }
  return {
    id,
    class: kind as CaseResult['class'],
    outcome: outcome as CaseResult['outcome'],
    detail,
    cost: { solariUsd: cost['solariUsd'], anthropicUsd: cost['anthropicUsd'] },
  };
}

function readNight(value: unknown, index: number): NightSummary {
  const where = `night ${String(index)}`;
  if (!isRecord(value)) fail(where, 'is not an object');
  const { date, colour, counts, cases, cost, costTargetUsd, overTarget, reasons } = value;
  if (typeof date !== 'string' || !DATE.test(date)) fail(where, `has date ${JSON.stringify(date)}`);
  if (!COLOURS.some((known) => known === colour)) fail(where, `has colour ${JSON.stringify(colour)}`);
  if (!isRecord(counts)) fail(where, 'has no counts');
  const { passed, failed, errored } = counts;
  if (!isFinite(passed) || !isFinite(failed) || !isFinite(errored)) fail(where, 'has no counts');
  if (!Array.isArray(cases)) fail(where, 'has no cases');
  if (
    !isRecord(cost) ||
    !isFinite(cost['solariUsd']) ||
    !isFinite(cost['anthropicUsd']) ||
    !isFinite(cost['totalUsd'])
  ) {
    fail(where, 'has no cost');
  }
  if (!isFinite(costTargetUsd)) fail(where, 'has no cost target');
  if (typeof overTarget !== 'boolean') fail(where, 'does not say whether it ran over target');
  if (!Array.isArray(reasons) || !reasons.every((reason) => typeof reason === 'string')) {
    fail(where, 'has no reasons');
  }
  return {
    date,
    colour: colour as NightColour,
    counts: { passed, failed, errored },
    cases: cases.map((entry: unknown, position) => readCase(entry, `${where} case ${String(position)}`)),
    cost: { solariUsd: cost['solariUsd'], anthropicUsd: cost['anthropicUsd'], totalUsd: cost['totalUsd'] },
    costTargetUsd,
    overTarget,
    reasons,
  };
}

/** The record the text holds, or an error naming what is wrong with it. */
export function parseNightsRecord(text: string): NightsRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`the nights record is not JSON: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  if (!Array.isArray(parsed)) fail('the document', 'is not an array of nights');
  return parsed.map((entry: unknown, index) => readNight(entry, index));
}

/** The record with tonight in it: one entry per date, oldest first. */
export function appendNight(record: NightsRecord, night: NightSummary): NightsRecord {
  return [...record.filter((entry) => entry.date !== night.date), night].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
}

const money = (usd: number): string => `$${usd.toFixed(2)}`;

/** The night, for a person: what ran, what it cost, and where the record stands. */
export function renderNightReport(night: NightSummary, verdict: RecordVerdict): string {
  const lines = [
    `# Live ops ${night.date}: ${night.colour.toUpperCase()}`,
    '',
    `- ${String(night.counts.passed)} passed, ${String(night.counts.failed)} failed, ${String(night.counts.errored)} errored`,
    `- cost ${money(night.cost.totalUsd)} of the ${money(night.costTargetUsd)} target (Solari ${money(night.cost.solariUsd)}, Anthropic ${money(night.cost.anthropicUsd)})${night.overTarget ? ' - OVER TARGET' : ''}`,
    `- record: ${verdict.reason}`,
    '',
    '| Case | Class | Outcome | Cost | Detail |',
    '|---|---|---|---|---|',
    ...night.cases.map(
      (result) =>
        `| ${result.id} | ${result.class} | ${result.outcome} | ${money(result.cost.solariUsd + result.cost.anthropicUsd)} | ${result.detail.replace(/\|/gu, '\\|')} |`,
    ),
  ];
  if (night.reasons.length > 0) {
    lines.push('', '## Why not green', '', ...night.reasons.map((reason) => `- ${reason}`));
  }
  return `${lines.join('\n')}\n`;
}

/** The record as the release checklist's table, one line per night, oldest first. */
export function renderNightsTable(record: NightsRecord): string {
  const ordered = [...record].sort((a, b) => a.date.localeCompare(b.date));
  const rows = ordered.map((night, index) => {
    const { consecutiveGreen } = judgeRecord(ordered.slice(0, index + 1));
    return `| ${night.date} | ${night.colour} | ${money(night.cost.totalUsd)} | ${money(night.costTargetUsd)} | ${String(consecutiveGreen)} |`;
  });
  return `${['| Date | Verdict | Cost | Target | Consecutive green |', '|---|---|---|---|---|', ...rows].join('\n')}\n`;
}
