import { describe, expect, it } from 'vitest';

import {
  appendNight,
  judgeRecord,
  parseNightsRecord,
  renderNightReport,
  renderNightsTable,
  summarizeNight,
  type CaseResult,
} from '../index.js';

/**
 * The record and its two renderings. The report is what a person reads on
 * a red morning, so it has to name every case with the word for what
 * happened to it; the table is what they copy into the release checklist,
 * so its header has to be the checklist's.
 */

const cases: readonly CaseResult[] = [
  { id: 'session-lifecycle', class: 'session', outcome: 'passed', detail: 'ok', cost: { solariUsd: 0.02, anthropicUsd: 0 } },
  {
    id: 'watch-checks',
    class: 'watch',
    outcome: 'failed',
    detail: 'the price selector matched nothing',
    cost: { solariUsd: 0.01, anthropicUsd: 0 },
  },
  {
    id: 'fixture-mission',
    class: 'mission',
    outcome: 'errored',
    detail: 'no browser | none installed',
    cost: { solariUsd: 0, anthropicUsd: 0.4 },
  },
  { id: 'eval-suite', class: 'eval', outcome: 'passed', detail: 'ok', cost: { solariUsd: 0, anthropicUsd: 1.5 } },
];

const red = summarizeNight({ date: '2026-09-03', cases, costTargetUsd: 5 });
const green = (date: string) =>
  summarizeNight({ date, cases: cases.map((result) => ({ ...result, outcome: 'passed', detail: 'ok' })), costTargetUsd: 5 });

describe('renderNightReport', () => {
  const report = renderNightReport(red, judgeRecord([red]));

  it('names the night, its colour, and every case with the word for what happened to it', () => {
    expect(report).toContain('# Live ops 2026-09-03: FAILED');
    expect(report).toContain('| session-lifecycle | session | passed |');
    expect(report).toContain('| watch-checks | watch | failed |');
    expect(report).toContain('| fixture-mission | mission | errored |');
    expect(report).toContain('| eval-suite | eval | passed |');
  });

  it('puts the cost against the target, per vendor, and says why the night is not green', () => {
    expect(report).toContain('cost $1.93 of the $5.00 target (Solari $0.03, Anthropic $1.90)');
    expect(report).toContain('## Why not green');
    expect(report).toContain('- watch case watch-checks failed: the price selector matched nothing');
    expect(report).toContain('- mission case fixture-mission errored: no browser | none installed');
    expect(report).toContain('- record: 0 green nights in a row since 2026-09-03 failed; the release wants 3');
  });

  it('says so, in capitals, when the night ran over target', () => {
    const dear = summarizeNight({ date: '2026-09-03', cases, costTargetUsd: 1 });
    expect(renderNightReport(dear, judgeRecord([dear]))).toContain(
      '- cost $1.93 of the $1.00 target (Solari $0.03, Anthropic $1.90) - OVER TARGET',
    );
  });

  it('keeps a pipe in a detail from breaking the table', () => {
    expect(report).toContain('| no browser \\| none installed |');
  });

  it('has no reasons section on a green night', () => {
    expect(renderNightReport(green('2026-09-04'), judgeRecord([green('2026-09-04')]))).not.toContain('Why not green');
  });
});

describe('the nights record', () => {
  const record = appendNight(appendNight(appendNight([], green('2026-09-02')), red), green('2026-09-01'));

  it('keeps one night per date, oldest first, and replaces a night rerun on the same date', () => {
    expect(record.map((night) => night.date)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    const rerun = appendNight(record, green('2026-09-03'));
    expect(rerun).toHaveLength(3);
    expect(rerun[2]?.colour).toBe('green');
  });

  it('round-trips through JSON', () => {
    expect(parseNightsRecord(JSON.stringify(record))).toEqual(record);
  });

  it('refuses a record that is not one, naming what is wrong', () => {
    expect(() => parseNightsRecord('{}')).toThrow('is not an array of nights');
    expect(() => parseNightsRecord('[{"date":"2026-09-01","colour":"amber"}]')).toThrow(
      'night 0 has colour "amber"',
    );
    expect(() => parseNightsRecord('nope')).toThrow('is not JSON');
  });

  it('renders as the table the release checklist copies, with the running green count', () => {
    const table = renderNightsTable(record);
    expect(table).toContain('| Date | Verdict | Cost | Target | Consecutive green |');
    expect(table).toContain('| 2026-09-01 | green | $1.93 | $5.00 | 1 |');
    expect(table).toContain('| 2026-09-02 | green | $1.93 | $5.00 | 2 |');
    expect(table).toContain('| 2026-09-03 | failed | $1.93 | $5.00 | 0 |');
  });
});

describe('a record that is not one', () => {
  const [first] = cases;
  const withNight = (patch: Record<string, unknown>): string => JSON.stringify([{ ...red, ...patch }]);
  const withCase = (patch: Record<string, unknown>): string => withNight({ cases: [{ ...first, ...patch }] });

  it.each([
    { what: 'text that is not JSON', text: 'not json', complaint: 'the nights record is not JSON: ' },
    { what: 'a document that is not a list', text: '{}', complaint: 'the document is not an array of nights' },
    { what: 'a night that is not an object', text: '[1]', complaint: 'night 0 is not an object' },
    { what: 'a night with a date that is not one', text: withNight({ date: 'yesterday' }), complaint: 'night 0 has date "yesterday"' },
    { what: 'a night with a colour that is not one', text: withNight({ colour: 'amber' }), complaint: 'night 0 has colour "amber"' },
    { what: 'a night whose counts are not an object', text: withNight({ counts: null }), complaint: 'night 0 has no counts' },
    { what: 'a night whose passed count is not a number', text: withNight({ counts: { passed: 'two', failed: 0, errored: 0 } }), complaint: 'night 0 has no counts' },
    { what: 'a night with no failed count', text: withNight({ counts: { passed: 2, errored: 0 } }), complaint: 'night 0 has no counts' },
    { what: 'a night with no errored count', text: withNight({ counts: { passed: 2, failed: 0 } }), complaint: 'night 0 has no counts' },
    { what: 'a night whose cases are not a list', text: withNight({ cases: 'none' }), complaint: 'night 0 has no cases' },
    { what: 'a night whose cost is not an object', text: withNight({ cost: 1.93 }), complaint: 'night 0 has no cost' },
    { what: 'a night with no Solari cost', text: withNight({ cost: { anthropicUsd: 1.9, totalUsd: 1.93 } }), complaint: 'night 0 has no cost' },
    { what: 'a night with no Anthropic cost', text: withNight({ cost: { solariUsd: 0.03, totalUsd: 1.93 } }), complaint: 'night 0 has no cost' },
    { what: 'a night with no total cost', text: withNight({ cost: { solariUsd: 0.03, anthropicUsd: 1.9 } }), complaint: 'night 0 has no cost' },
    { what: 'a night whose cost target is not a number', text: withNight({ costTargetUsd: '5' }), complaint: 'night 0 has no cost target' },
    { what: 'a night that does not say whether it ran over target', text: withNight({ overTarget: 'yes' }), complaint: 'night 0 does not say whether it ran over target' },
    { what: 'a night whose reasons are not a list', text: withNight({ reasons: 'because' }), complaint: 'night 0 has no reasons' },
    { what: 'a night with a reason that is not text', text: withNight({ reasons: [1] }), complaint: 'night 0 has no reasons' },
    { what: 'a case that is not an object', text: withNight({ cases: [1] }), complaint: 'night 0 case 0 is not an object' },
    { what: 'a case with no id', text: withCase({ id: undefined }), complaint: 'night 0 case 0 has no id' },
    { what: 'a case with an empty id', text: withCase({ id: '' }), complaint: 'night 0 case 0 has no id' },
    { what: 'a case with a class that is not one', text: withCase({ class: 'nap' }), complaint: 'night 0 case 0 has class "nap"' },
    { what: 'a case with an outcome that is not one', text: withCase({ outcome: 'meh' }), complaint: 'night 0 case 0 has outcome "meh"' },
    { what: 'a case with no detail', text: withCase({ detail: 5 }), complaint: 'night 0 case 0 has no detail' },
    { what: 'a case whose cost is not an object', text: withCase({ cost: 0.02 }), complaint: 'night 0 case 0 has no cost per vendor' },
    { what: 'a case with no Solari cost', text: withCase({ cost: { anthropicUsd: 0 } }), complaint: 'night 0 case 0 has no cost per vendor' },
    { what: 'a case with no Anthropic cost', text: withCase({ cost: { solariUsd: 0.02 } }), complaint: 'night 0 case 0 has no cost per vendor' },
  ])('refuses $what, naming what is wrong', ({ text, complaint }) => {
    expect(() => parseNightsRecord(text)).toThrow(complaint);
  });
});
