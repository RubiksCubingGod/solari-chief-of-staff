import { describe, expect, it } from 'vitest';

import {
  CALENDAR_ITEM_KINDS,
  TASK_EVENT_TYPES,
  TASK_KINDS,
  TASK_MODES,
  TASK_STATUSES,
  WATCH_KINDS,
  isCalendarItemKind,
  isTaskEventType,
  isTaskKind,
  isTaskMode,
  isTaskStatus,
  isWatchKind,
  memberGuard,
} from './index.js';

describe('memberGuard', () => {
  const isColour = memberGuard(['red', 'blue'] as const);

  it('accepts a listed member', () => {
    expect(isColour('red')).toBe(true);
  });

  it('rejects an unlisted string', () => {
    expect(isColour('green')).toBe(false);
  });

  it('rejects a non-string without consulting the list', () => {
    expect(isColour(1)).toBe(false);
    expect(isColour(null)).toBe(false);
    expect(isColour(undefined)).toBe(false);
  });
});

describe('domain vocabulary', () => {
  const lists = [
    { name: 'WATCH_KINDS', values: WATCH_KINDS, guard: isWatchKind },
    { name: 'TASK_KINDS', values: TASK_KINDS, guard: isTaskKind },
    { name: 'TASK_STATUSES', values: TASK_STATUSES, guard: isTaskStatus },
    { name: 'TASK_MODES', values: TASK_MODES, guard: isTaskMode },
    { name: 'TASK_EVENT_TYPES', values: TASK_EVENT_TYPES, guard: isTaskEventType },
    { name: 'CALENDAR_ITEM_KINDS', values: CALENDAR_ITEM_KINDS, guard: isCalendarItemKind },
  ] as const satisfies readonly {
    name: string;
    values: readonly string[];
    guard: (value: unknown) => boolean;
  }[];

  it.each(lists)('$name has no duplicate members', ({ values }) => {
    expect(new Set(values).size).toBe(values.length);
  });

  it.each(lists)('$name guard accepts every member and rejects a stranger', ({ values, guard }) => {
    for (const value of values) {
      expect(guard(value)).toBe(true);
    }
    expect(guard('not-a-member')).toBe(false);
  });
});
