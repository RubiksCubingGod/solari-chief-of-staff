import {
  CALENDAR_ITEM_KINDS,
  MESSAGE_DIRECTIONS,
  TASK_STATUSES,
  TIER_POLICIES,
  WATCH_KINDS,
  type CalendarItemKind,
  type TaskStatus,
  type TierPolicy,
  type WatchKind,
} from '@chief-of-staff/core';
import {
  calendarItems,
  messages,
  tasks,
  watches,
  type CalendarItem,
  type NewWatch,
  type Task,
  type Watch,
} from '@chief-of-staff/db';
import { describe, expect, expectTypeOf, it } from 'vitest';

/**
 * The api package is still a stub, which is exactly what makes it the right
 * place for this: it consumes `@chief-of-staff/db` the way every later package
 * will, so a schema that only type-checks inside its own package fails here.
 */
describe('the exported Drizzle schema, seen from a dependent package', () => {
  it('builds its Postgres enums from the shared domain vocabulary', () => {
    expect(watches.kind.enumValues).toEqual([...WATCH_KINDS]);
    expect(watches.tierPolicy.enumValues).toEqual([...TIER_POLICIES]);
    expect(tasks.status.enumValues).toEqual([...TASK_STATUSES]);
    expect(calendarItems.kind.enumValues).toEqual([...CALENDAR_ITEM_KINDS]);
    expect(messages.direction.enumValues).toEqual([...MESSAGE_DIRECTIONS]);
  });

  it('infers row types that are the core unions, not widened strings', () => {
    expectTypeOf<Watch['kind']>().toEqualTypeOf<WatchKind>();
    expectTypeOf<Watch['tierPolicy']>().toEqualTypeOf<TierPolicy>();
    expectTypeOf<Task['status']>().toEqualTypeOf<TaskStatus>();
    expectTypeOf<CalendarItem['kind']>().toEqualTypeOf<CalendarItemKind>();
  });

  it('makes defaulted and nullable columns optional on insert', () => {
    const draft: NewWatch = {
      userId: '00000000-0000-0000-0000-000000000000',
      kind: 'price',
      url: 'https://example.test/widget',
      extractor: { selector: '.price', parse: 'price' },
      condition: { below_cents: 4999 },
      schedule: '*/15 * * * *',
    };

    expectTypeOf<NewWatch['id']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Watch['lastValue']>().toEqualTypeOf<unknown>();
    expect(draft.status).toBeUndefined();
  });
});
