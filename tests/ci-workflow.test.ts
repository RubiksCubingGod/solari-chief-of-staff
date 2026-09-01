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
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Record<string, unknown>;
}

interface Workflow {
  readonly name?: string;
  readonly on?: Record<string, unknown>;
  readonly jobs?: Record<string, { 'runs-on'?: string; steps?: Step[] }>;
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
