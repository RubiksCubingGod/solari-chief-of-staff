import { cancellationSiteOf } from '@chief-of-staff/core';
import {
  readSiteConnection,
  type CancellationPlan,
  type CancellationPlanner,
  type TaskDatabase,
} from '@chief-of-staff/db';

import type { PlaybookRegistry } from './runner/registry.js';

/**
 * The calendar scan's link to the playbooks (auto-cancel-path spec).
 *
 * The scan knows an entry is flagged and due; it does not know which sites
 * have a playbook, or whether this person is signed in to one. Those are
 * this package's facts, so the planner lives here and the scan takes it as
 * a port. It answers before any task exists: an entry nothing can act on is
 * marked so on the calendar, in words, rather than becoming a task that
 * fails an hour later in the worker's log where nobody is looking.
 *
 * What the planner checks is exactly what the runner will check again when
 * the task runs - the site, the playbook, the connection - so a task that is
 * armed is one that can run. The one thing it cannot know is whether the
 * credential still works, and that is the task's own failure to report.
 */

export interface CancellationPlannerOptions {
  readonly db: TaskDatabase;
  readonly registry: PlaybookRegistry;
}

export function createCancellationPlanner(options: CancellationPlannerOptions): CancellationPlanner {
  const { db, registry } = options;
  return async (item): Promise<CancellationPlan> => {
    const site = cancellationSiteOf(item.action);
    if (site === undefined) return unlinked('the entry names no site to cancel on');
    const playbook = registry.lookup(site, 'cancel');
    if (playbook === undefined) return unlinked(`no playbook can cancel on ${site}`);
    if (playbook.access !== 'open') {
      const connection = await readSiteConnection(db, item.userId, playbook.siteDomain);
      if (connection === undefined) {
        return unlinked(`no connected site for ${playbook.siteDomain}`);
      }
      if (connection.status !== 'connected') {
        return unlinked(`the site connection for ${playbook.siteDomain} is ${connection.status}`);
      }
    }
    return { kind: 'task', input: { site } };
  };
}

function unlinked(reason: string): CancellationPlan {
  return { kind: 'unlinked', reason };
}
