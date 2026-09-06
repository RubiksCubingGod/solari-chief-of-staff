import { describe, expect, it } from 'vitest';

import { TASK_EVENT_TYPES, TASK_STATUSES, type TaskStatus } from './index.js';
import {
  REJECTION_REASONS,
  TASK_TRANSITIONS,
  TERMINAL_TASK_STATUSES,
  TRANSITION_CAUSES,
  isTerminalTaskStatus,
  transitionTarget,
} from './task-lifecycle.js';

describe('the task transition table', () => {
  it('has exactly one rule per cause', () => {
    expect(Object.keys(TASK_TRANSITIONS).sort()).toEqual([...TRANSITION_CAUSES].sort());
  });

  it('only ever names listed statuses', () => {
    for (const cause of TRANSITION_CAUSES) {
      const rule = TASK_TRANSITIONS[cause];
      expect(TASK_STATUSES).toContain(rule.to);
      for (const from of rule.from) expect(TASK_STATUSES).toContain(from);
      expect(rule.from.length).toBeGreaterThan(0);
    }
  });

  it('reaches every status from somewhere, queued included', () => {
    const reachable = new Set(TRANSITION_CAUSES.map((cause) => TASK_TRANSITIONS[cause].to));
    expect([...reachable].sort()).toEqual([...TASK_STATUSES].sort());
  });

  it('gives a terminal status no way out', () => {
    for (const status of TERMINAL_TASK_STATUSES) {
      expect(isTerminalTaskStatus(status)).toBe(true);
      for (const cause of TRANSITION_CAUSES) {
        expect(transitionTarget(status, cause)).toBeUndefined();
      }
    }
  });

  it('gives every other status at least one way on', () => {
    const open = TASK_STATUSES.filter((status) => !isTerminalTaskStatus(status));
    expect(open).toEqual(['queued', 'running', 'waiting_user']);
    for (const status of open) {
      const exits = TRANSITION_CAUSES.filter((cause) => transitionTarget(status, cause) !== undefined);
      expect(exits.length).toBeGreaterThan(0);
    }
  });

  it('answers the questions the ledger asks', () => {
    const cases: [TaskStatus, (typeof TRANSITION_CAUSES)[number], TaskStatus | undefined][] = [
      ['queued', 'started', 'running'],
      ['queued', 'resumed', 'running'],
      ['running', 'retried', 'running'],
      ['running', 'asked', 'waiting_user'],
      ['waiting_user', 'answered', 'queued'],
      ['running', 'succeeded', 'succeeded'],
      ['running', 'error', 'failed'],
      ['running', 'violation', 'failed'],
      ['running', 'refused', 'failed'],
      ['waiting_user', 'timeout', 'failed'],
      ['running', 'orphaned', 'failed'],
      ['waiting_user', 'declined', 'cancelled'],
      // The refusals the integration proof exercises.
      ['queued', 'succeeded', undefined],
      ['succeeded', 'started', undefined],
      ['running', 'answered', undefined],
      ['waiting_user', 'refused', undefined],
      ['waiting_user', 'succeeded', undefined],
    ];
    for (const [status, cause, target] of cases) {
      expect(transitionTarget(status, cause), `${status} + ${cause}`).toBe(target);
    }
  });
});

describe('the vocabulary the machine adds', () => {
  it('has a cancelled status for a declined question and a rejected event for a refused move', () => {
    expect(TASK_STATUSES).toContain('cancelled');
    expect(TASK_EVENT_TYPES).toContain('rejected');
  });

  it('lists each rejection reason once', () => {
    expect(new Set(REJECTION_REASONS).size).toBe(REJECTION_REASONS.length);
  });
});
