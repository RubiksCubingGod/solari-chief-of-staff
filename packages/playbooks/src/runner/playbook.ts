import type { TaskKind } from '@chief-of-staff/core';
import type { SiteConnection, Task, TaskAnswer } from '@chief-of-staff/db';
import type { Page } from 'playwright';

import type { DomainAllowlist } from '../guardrails/index.js';

/**
 * A playbook is a typed step program: an ordered list of steps, each driving
 * the guarded page and answering with one of four outcomes. The runner owns
 * everything around the steps - the session, the guardrails, the trail, the
 * transitions - so a playbook is only what a site demands, in order.
 *
 * Steps run from the top on every invocation. A task that parked on a
 * question comes back as a fresh mission with the reply among its `answers`,
 * in a fresh browser: whatever the earlier run's page held is gone, and a
 * step that already happened on the site (a login, a form) has to be at peace
 * with finding it done.
 */

/** What a site connection yields for a login step. */
export type SiteCredential =
  /** The Solari profile the connection names. Cookies live in the provider's store, never here: the production case. */
  | { readonly kind: 'profile'; readonly profileId: string }
  /** A username and password for a fixture's login form. The proofs' case; nothing of the kind is ever read from the database. */
  | { readonly kind: 'password'; readonly username: string; readonly password: string };

export interface PlaybookContext {
  readonly task: Task;
  /** The task's input as a record. A task whose input is not one never reaches a step. */
  readonly input: Readonly<Record<string, unknown>>;
  /**
   * The person's connection to the site, and what it yields for a login step.
   * Absent for an `open` playbook: the site has no account to sign in to.
   */
  readonly connection?: SiteConnection;
  readonly credential?: SiteCredential;
  /** Every answer accepted so far, oldest first. */
  readonly answers: readonly TaskAnswer[];
  /** The latest accepted reply to exactly this question, or `undefined` while nobody has given one. */
  readonly answerTo: (question: string) => string | undefined;
  /**
   * Marks the connection expired, for a step that found the site no longer
   * honours its session. Absent for an `open` playbook. The runner supplies
   * it; a step only ever asks by failing with `reconnect`.
   */
  readonly expireConnection?: () => Promise<void>;
}

export type StepOutcome =
  | {
      readonly kind: 'done';
      readonly detail?: unknown;
      /**
       * Fields for the task's result, beside the trail: what a reader of the
       * finished task needs at hand, such as a booking reference. The runner
       * folds them into the result under its own fields.
       */
      readonly result?: Readonly<Record<string, unknown>>;
    }
  /** The step needs a person. The mission parks here and runs again once there is a reply. */
  | { readonly kind: 'ask'; readonly question: string }
  | {
      readonly kind: 'failed';
      readonly reason: string;
      readonly detail?: unknown;
      /**
       * The site asked for a full sign-in: the profile's session is gone. The
       * runner flips the connection to `expired`, so the dashboard shows the
       * person what to redo and no later task signs in with a dead session.
       */
      readonly reconnect?: boolean;
    }
  /**
   * The site, or the person, would not do what the task asked: nothing broke
   * and there is nothing to retry. The task fails by `refused`, and `detail`
   * says which refusal, in whatever vocabulary the task's kind shares with
   * the reader of its outcome.
   */
  | { readonly kind: 'refused'; readonly reason: string; readonly detail?: unknown };

export interface PlaybookStep {
  /** The trail's name for the step. Unique within its playbook. */
  readonly name: string;
  run(page: Page, context: PlaybookContext): Promise<StepOutcome>;
}

/**
 * Whether the playbook signs in. `connection` needs the person's connection to
 * the site, and its credential, before a step runs; `open` runs against a
 * site with no account behind it, in a session with no profile.
 */
export type PlaybookAccess = 'connection' | 'open';

export interface Playbook {
  /** Written to the task row as `playbook_id`, e.g. `fakegym.cancel`. */
  readonly id: string;
  /** The site a task names in its input. */
  readonly site: string;
  readonly action: TaskKind;
  /** Where the site is. The steps' starting point. */
  readonly origin: string;
  /** The `site_domain` of the connection the playbook signs in with: the origin's host, port included. */
  readonly siteDomain: string;
  readonly access: PlaybookAccess;
  /** Every host the steps may take the browser to. */
  readonly allowlist: DomainAllowlist;
  readonly steps: readonly PlaybookStep[];
}

export interface PlaybookDefinition {
  /** Defaults to `<site>.<action>`. */
  readonly id?: string;
  readonly site: string;
  readonly action: TaskKind;
  readonly origin: string;
  /** Hosts besides the origin's own that the steps may visit. */
  readonly alsoAllow?: DomainAllowlist;
  /** `connection` unless said otherwise: a playbook that signs in to nothing has to say so. */
  readonly access?: PlaybookAccess;
  readonly steps: readonly PlaybookStep[];
}

/**
 * A playbook from what a site author has to say. The origin gives the
 * connection's domain and the allowlist's first host, so a playbook cannot be
 * written whose login and lane disagree; the checks here are the ones a
 * registry cannot make for a playbook it has not seen run.
 */
export function definePlaybook(definition: PlaybookDefinition): Playbook {
  let origin: URL;
  try {
    origin = new URL(definition.origin);
  } catch {
    throw new Error(`playbook ${definition.site}.${definition.action}: origin ${definition.origin} is not a URL`);
  }
  if (definition.site.trim() === '') throw new Error('a playbook needs a site');
  if (definition.steps.length === 0) {
    throw new Error(`playbook ${definition.site}.${definition.action} has no steps`);
  }
  const names = new Set<string>();
  for (const step of definition.steps) {
    if (step.name.trim() === '' || names.has(step.name)) {
      throw new Error(`playbook ${definition.site}.${definition.action}: step names must be unique and non-empty`);
    }
    names.add(step.name);
  }
  return {
    id: definition.id ?? `${definition.site}.${definition.action}`,
    site: definition.site,
    action: definition.action,
    origin: origin.origin,
    siteDomain: origin.host,
    access: definition.access ?? 'connection',
    allowlist: [origin.hostname, ...(definition.alsoAllow ?? [])],
    steps: [...definition.steps],
  };
}
