import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * CI is only worth having if it runs the same gate a developer runs. These
 * assertions pin the parts that would silently stop being true: a workflow that
 * stops firing on push, an install that stops respecting the lockfile, or a job
 * that runs some subset of `pnpm check` instead of the whole thing.
 */

interface Step {
  readonly if?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Record<string, unknown>;
}

interface Job {
  readonly 'runs-on'?: string;
  readonly needs?: string | readonly string[];
  readonly if?: string;
  readonly env?: Record<string, string>;
  readonly outputs?: Record<string, string>;
  readonly steps?: Step[];
}

interface Workflow {
  readonly name?: string;
  readonly on?: Record<string, unknown>;
  readonly concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  readonly jobs?: Record<string, Job>;
}

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const workflow = parse(read('../.github/workflows/check.yml')) as Workflow;
const manifest = JSON.parse(read('../package.json')) as {
  engines: { node: string };
  packageManager: string;
  scripts: Record<string, string>;
};

const job = workflow.jobs?.['check'];
const steps = job?.steps ?? [];
const runs = steps.flatMap((step) => (step.run === undefined ? [] : [step.run]));

function stepUsing(action: string): Step | undefined {
  return steps.find((step) => step.uses?.startsWith(`${action}@`) === true);
}

describe('.github/workflows/check.yml', () => {
  it('fires on every push and on pull requests', () => {
    expect(Object.keys(workflow.on ?? {})).toEqual(
      expect.arrayContaining(['push', 'pull_request']),
    );
  });

  it('runs the same gate a developer runs, and nothing narrower', () => {
    expect(runs).toContain('pnpm check');
    expect(manifest.scripts['check']).toBe('node scripts/check.mjs');
  });

  it('installs the browser the provider contract suite drives, before the gate', () => {
    // `pnpm install` does not fetch it, so without this step the contract suite
    // fails on every push with a missing executable rather than a real defect.
    const browsers = runs.findIndex((run) => run.startsWith('pnpm browsers'));
    expect(browsers).toBeGreaterThanOrEqual(0);
    expect(runs.indexOf('pnpm check')).toBeGreaterThan(browsers);
    expect(manifest.scripts['browsers']).toBe('node scripts/browsers.mjs');
  });

  it('installs from the lockfile so CI cannot silently resolve newer versions', () => {
    expect(runs).toContain('pnpm install --frozen-lockfile');
  });

  it('runs the Node version the workspace declares', () => {
    const declared = manifest.engines.node.replace(/^>=/u, '').split('.')[0];
    expect(String(stepUsing('actions/setup-node')?.with?.['node-version'])).toBe(declared);
  });

  it('takes the pnpm version from the manifest rather than repeating it', () => {
    // Two places to bump is one place to forget; pnpm/action-setup reads
    // `packageManager` when no version is pinned in the workflow.
    expect(manifest.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/u);
    expect(stepUsing('pnpm/action-setup')?.with?.['version']).toBeUndefined();
  });

  it('checks the repository out before it tries to install it', () => {
    const checkout = steps.findIndex((step) => step.uses?.startsWith('actions/checkout@') === true);
    const install = steps.findIndex((step) => step.run === 'pnpm install --frozen-lockfile');
    expect(checkout).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(checkout);
  });
});

describe('.github/pull_request_template.md', () => {
  const template = read('../.github/pull_request_template.md');

  it('carries the manual checklist the automated gate cannot cover', () => {
    expect(template).toMatch(/## Manual checks/u);
    // Unticked boxes: a template that ships them ticked is a template nobody
    // reads.
    expect(template).toMatch(/- \[ \] /u);
    expect(template).not.toMatch(/- \[x\] /iu);
  });
});

const liveSmoke = parse(read('../.github/workflows/live-smoke.yml')) as Workflow;
const liveSmokeJob = liveSmoke.jobs?.['live-smoke'];
const liveSmokeRuns = (liveSmokeJob?.steps ?? []).flatMap((step) =>
  step.run === undefined ? [] : [step.run],
);

describe('.github/workflows/live-smoke.yml', () => {
  it('fires only on a schedule or a manual dispatch, never on push or pull request', () => {
    // The whole cost story rests on this. On `push` it would spend vendor
    // credit per commit; on `pull_request` a fork could not read the secret and
    // would report a green run that called nothing at all.
    const triggers = Object.keys(liveSmoke.on ?? {}).sort();
    expect(triggers).toEqual(['schedule', 'workflow_dispatch']);
  });

  it('carries an actual cron entry rather than an empty schedule', () => {
    const schedule = (liveSmoke.on ?? {})['schedule'];
    expect(Array.isArray(schedule)).toBe(true);
    expect((schedule as { cron?: string }[])[0]?.cron).toMatch(/^\S+ \S+ \S+ \S+ \S+$/u);
  });

  it('reports a missing secret as a skipped job instead of a green one', () => {
    // A job-level `if` cannot read `secrets`, so the presence check is a job of
    // its own and the smoke depends on its output. When the key is absent the
    // smoke job is *skipped* in the run summary - which is the point: the one
    // outcome that must never happen is a green run that called nothing.
    expect(liveSmokeJob?.needs).toBe('guard');
    expect(liveSmokeJob?.if).toContain("needs.guard.outputs.configured == 'true'");
    expect(liveSmoke.jobs?.['guard']?.outputs?.['configured']).toContain('steps.key.outputs');
  });

  it('queues an overlapping run rather than cancelling one mid-session', () => {
    // A cancelled live run abandons a real browser session, and the slot stays
    // held until the vendor's orphan reaper gets to it.
    expect(liveSmoke.concurrency?.group).toBe('live-smoke');
    expect(liveSmoke.concurrency?.['cancel-in-progress']).toBe(false);
  });

  it('runs the same entry point a developer runs, and hands it the secret', () => {
    expect(liveSmokeRuns).toContain('node scripts/live-smoke.mjs');
    expect(liveSmokeJob?.env?.['SOLARI_API_KEY']).toContain('secrets.SOLARI_API_KEY');
    // The script has to exist under the name the workflow calls; `read` throws
    // if a rename ever leaves the nightly pointing at nothing.
    expect(read('../scripts/live-smoke.mjs')).toContain('SOLARI_LIVE_SMOKE');
  });

  it('installs from the lockfile, like every other job here', () => {
    expect(liveSmokeRuns).toContain('pnpm install --frozen-lockfile');
  });
});

const liveOps = parse(read('../.github/workflows/live-ops.yml')) as Workflow;
const liveOpsJob = liveOps.jobs?.['live-ops'];
const liveOpsSteps = liveOpsJob?.steps ?? [];
const liveOpsRuns = liveOpsSteps.flatMap((step) => (step.run === undefined ? [] : [step.run]));
const liveOpsScript = read('../scripts/live-ops.mjs');

describe('.github/workflows/live-ops.yml', () => {
  it('fires only on a schedule or a manual dispatch, never on push or pull request', () => {
    expect(Object.keys(liveOps.on ?? {}).sort()).toEqual(['schedule', 'workflow_dispatch']);
  });

  it("carries a cron entry of its own, off the other nightlies' minutes", () => {
    // Three nightlies on one minute would share a runner's worst hour, and a
    // night that ran while the smoke held a session would count it twice.
    const cronOf = (workflow: Workflow): string | undefined =>
      ((workflow.on ?? {})['schedule'] as { cron?: string }[] | undefined)?.[0]?.cron;
    const cron = cronOf(liveOps);
    expect(cron).toMatch(/^\S+ \S+ \S+ \S+ \S+$/u);
    expect(cron).not.toBe(cronOf(liveSmoke));
    expect(cron).not.toBe(cronOf(parse(read('../.github/workflows/live-evals.yml')) as Workflow));
  });

  it('skips, never passes, when either key is missing', () => {
    expect(liveOpsJob?.needs).toBe('guard');
    expect(liveOpsJob?.if).toContain("needs.guard.outputs.configured == 'true'");
    const guard = liveOps.jobs?.['guard'];
    expect(guard?.outputs?.['configured']).toContain('steps.key.outputs');
    const key = guard?.steps?.find((step) => step.run?.includes('configured=true') === true);
    expect(key?.run).toContain('SOLARI_API_KEY');
    expect(key?.run).toContain('ANTHROPIC_API_KEY');
  });

  it('queues an overlapping night rather than cancelling one mid-measurement', () => {
    expect(liveOps.concurrency?.group).toBe('live-ops');
    expect(liveOps.concurrency?.['cancel-in-progress']).toBe(false);
  });

  it('runs the one entry point, hands it both keys, and holds it to a cost target', () => {
    expect(liveOpsRuns).toContain('node scripts/live-ops.mjs');
    expect(manifest.scripts['live-ops']).toBe('node scripts/live-ops.mjs');
    expect(liveOpsJob?.env?.['SOLARI_API_KEY']).toContain('secrets.SOLARI_API_KEY');
    expect(liveOpsJob?.env?.['ANTHROPIC_API_KEY']).toContain('secrets.ANTHROPIC_API_KEY');
    expect(liveOpsJob?.env?.['LIVE_OPS_COST_TARGET_USD']).toBeDefined();
    expect(liveOpsScript).toContain('LIVE_OPS_COST_TARGET_USD');
  });

  it('runs one case per class the release counts, each reported apart', () => {
    for (const kind of ['session', 'watch', 'mission', 'eval']) {
      expect(liveOpsScript).toContain(`class: '${kind}'`);
    }
    // The three words a night's cases can end in, each its own annotation in
    // the run: the report must never fold an outage into a regression.
    expect(liveOpsScript).toMatch(/passed: 'notice', failed: 'error', errored: 'warning'/u);
  });

  it('uploads the night and its record whatever the verdict, for a person to copy', () => {
    const upload = liveOpsSteps.find((step) => step.uses?.startsWith('actions/upload-artifact@') === true);
    expect(upload?.if).toBe('always()');
    expect(String(upload?.with?.['path'])).toBe('live-ops/');
    expect(liveOpsJob?.env?.['LIVE_OPS_REPORT_DIR']).toBe('live-ops');
  });

  it('installs from the lockfile and the browser, before the night', () => {
    expect(liveOpsRuns).toContain('pnpm install --frozen-lockfile');
    const browsers = liveOpsRuns.findIndex((run) => run.startsWith('pnpm browsers'));
    expect(browsers).toBeGreaterThanOrEqual(0);
    expect(liveOpsRuns.indexOf('node scripts/live-ops.mjs')).toBeGreaterThan(browsers);
  });
});

describe('the ordinary gate stays offline', () => {
  it('never puts the Solari key anywhere near the push-triggered check', () => {
    // `check.yml` runs on every push. If the key ever reaches it, the live
    // suite's opt-in guard becomes the only thing standing between a commit and
    // a bill - and guards get edited.
    expect(read('../.github/workflows/check.yml')).not.toContain('SOLARI_API_KEY');
    expect(read('../.github/workflows/check.yml')).not.toContain('ANTHROPIC_API_KEY');
  });
});
