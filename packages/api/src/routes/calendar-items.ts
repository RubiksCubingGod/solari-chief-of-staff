import { CALENDAR_ITEM_KINDS } from '@chief-of-staff/core';
import type { CalendarItemKind } from '@chief-of-staff/core';
import { calendarItems } from '@chief-of-staff/db';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { callerHeaderSchema, resolveCaller } from '../caller.js';

interface CreateCalendarItemBody {
  readonly kind: CalendarItemKind;
  readonly name: string;
  readonly amountCents?: number;
  readonly renewOn?: string;
  readonly cancelBy?: string;
  readonly action?: Record<string, unknown>;
  readonly reminderLeadDays?: number;
  readonly autoCancel?: boolean;
  readonly autoCancelLeadDays?: number;
}

const createCalendarItemBodySchema = {
  type: 'object',
  required: ['kind', 'name'],
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: [...CALENDAR_ITEM_KINDS] },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    // Money is integer cents everywhere; a float here is a rounding bug later.
    amountCents: { type: 'integer', minimum: 0 },
    renewOn: { type: 'string', format: 'iso-date' },
    cancelBy: { type: 'string', format: 'iso-date' },
    // What to do when the date comes. A cancellation names its site here, as
    // `{ "site": "fakegym" }`, and the worker matches that to a playbook.
    action: { type: 'object' },
    // Days ahead of the date the reminder goes out, and ahead of the renewal
    // the cancellation is armed; both default in the schema, and a year is
    // the most either can mean.
    reminderLeadDays: { type: 'integer', minimum: 0, maximum: 365 },
    // A subscription the worker cancels ahead of its renewal, behind a yes
    // over Telegram.
    autoCancel: { type: 'boolean' },
    autoCancelLeadDays: { type: 'integer', minimum: 0, maximum: 365 },
  },
  // The daily cron in ARCHITECTURE §3.3 scans for a date. An item that carries
  // none of the date its kind is scanned by would never be reminded about, so
  // it is refused at the door rather than stored as a row nothing reads.
  allOf: [
    {
      if: { properties: { kind: { const: 'subscription' } }, required: ['kind'] },
      then: { required: ['renewOn'] },
    },
    {
      if: { properties: { kind: { const: 'deadline' } }, required: ['kind'] },
      then: { required: ['cancelBy'] },
    },
    // Only a subscription renews, so only a subscription can be cancelled
    // ahead of renewing. A deadline flagged for it is a mistake, refused here
    // rather than stored as a flag the scan would never read.
    {
      if: { properties: { autoCancel: { const: true } }, required: ['autoCancel'] },
      then: { properties: { kind: { const: 'subscription' } } },
    },
  ],
} as const;

export function registerCalendarItemRoutes(app: FastifyInstance): void {
  app.post(
    '/calendar-items',
    {
      schema: { headers: callerHeaderSchema, body: createCalendarItemBodySchema },
      preHandler: resolveCaller,
    },
    async (request: FastifyRequest<{ Body: CreateCalendarItemBody }>, reply) => {
      const body = request.body;
      const [created] = await app.db
        .insert(calendarItems)
        .values({
          userId: request.userId,
          kind: body.kind,
          name: body.name,
          amountCents: body.amountCents ?? null,
          renewOn: body.renewOn ?? null,
          cancelBy: body.cancelBy ?? null,
          action: body.action ?? null,
          // Left to the schema's defaults when absent, so the row says what
          // the scan will do rather than what the caller did not say.
          ...(body.reminderLeadDays === undefined ? {} : { reminderLeadDays: body.reminderLeadDays }),
          ...(body.autoCancel === undefined ? {} : { autoCancel: body.autoCancel }),
          ...(body.autoCancelLeadDays === undefined
            ? {}
            : { autoCancelLeadDays: body.autoCancelLeadDays }),
        })
        .returning();
      return reply.status(201).send(created);
    },
  );

  app.get(
    '/calendar-items',
    { schema: { headers: callerHeaderSchema }, preHandler: resolveCaller },
    async (request) =>
      app.db
        .select()
        .from(calendarItems)
        .where(eq(calendarItems.userId, request.userId))
        .orderBy(asc(calendarItems.name), asc(calendarItems.id)),
  );
}
