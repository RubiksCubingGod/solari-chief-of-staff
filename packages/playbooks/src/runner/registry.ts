import type { TaskKind } from '@chief-of-staff/core';

import type { Playbook } from './playbook.js';

/**
 * The playbooks a worker can run, keyed by the site a task names and the
 * kind of task it is. One playbook per pair: two that claim the same pair
 * would make which one runs a matter of registration order, so the registry
 * refuses to be built rather than pick.
 */
export interface PlaybookRegistry {
  readonly playbooks: readonly Playbook[];
  lookup(site: string, action: TaskKind): Playbook | undefined;
}

function key(site: string, action: TaskKind): string {
  return `${action}@${site}`;
}

export function createPlaybookRegistry(playbooks: readonly Playbook[]): PlaybookRegistry {
  const byKey = new Map<string, Playbook>();
  for (const playbook of playbooks) {
    const claim = key(playbook.site, playbook.action);
    const other = byKey.get(claim);
    if (other !== undefined) {
      throw new Error(
        `playbooks ${other.id} and ${playbook.id} both claim ${playbook.action} on ${playbook.site}`,
      );
    }
    byKey.set(claim, playbook);
  }
  return {
    playbooks: [...playbooks],
    lookup: (site, action) => byKey.get(key(site, action)),
  };
}
