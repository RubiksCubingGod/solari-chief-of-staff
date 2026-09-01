import { describe, expect, it } from 'vitest';

import {
  CALENDAR_ITEM_KINDS,
  CALENDAR_ITEM_STATUSES,
  DELIVERY_STATUSES,
  FETCH_TIERS,
  MESSAGE_CHANNELS,
  MESSAGE_DIRECTIONS,
  SITE_CONNECTION_STATUSES,
  TASK_EVENT_TYPES,
  TASK_KINDS,
  TASK_MODES,
  TASK_STATUSES,
  TIER_POLICIES,
  WATCH_KINDS,
  WATCH_STATUSES,
  isCalendarItemKind,
  isCalendarItemStatus,
  isDeliveryStatus,
  isFetchTier,
  isMessageChannel,
  isMessageDirection,
  isSiteConnectionStatus,
  isTaskEventType,
  isTaskKind,
  isTaskMode,
  isTaskStatus,
  isTierPolicy,
  isWatchKind,
  isWatchStatus,
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
    { name: 'WATCH_STATUSES', values: WATCH_STATUSES, guard: isWatchStatus },
    { name: 'FETCH_TIERS', values: FETCH_TIERS, guard: isFetchTier },
    { name: 'TIER_POLICIES', values: TIER_POLICIES, guard: isTierPolicy },
    {
      name: 'SITE_CONNECTION_STATUSES',
      values: SITE_CONNECTION_STATUSES,
      guard: isSiteConnectionStatus,
    },
    { name: 'CALENDAR_ITEM_STATUSES', values: CALENDAR_ITEM_STATUSES, guard: isCalendarItemStatus },
    { name: 'MESSAGE_DIRECTIONS', values: MESSAGE_DIRECTIONS, guard: isMessageDirection },
    { name: 'MESSAGE_CHANNELS', values: MESSAGE_CHANNELS, guard: isMessageChannel },
    { name: 'DELIVERY_STATUSES', values: DELIVERY_STATUSES, guard: isDeliveryStatus },
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
