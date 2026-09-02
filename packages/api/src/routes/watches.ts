import { TIER_POLICIES, WATCH_KINDS, WATCH_STATUSES, watchConfigViolations } from '@chief-of-staff/core';
import type { TierPolicy, WatchKind, WatchStatus } from '@chief-of-staff/core';
import { watches } from '@chief-of-staff/db';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { callerHeaderSchema, resolveCaller } from '../caller.js';
import { HttpError } from '../errors.js';

interface CreateWatchBody {
  readonly kind: WatchKind;
  readonly url: string;
  readonly schedule: string;
  readonly condition: Record<string, unknown>;
  readonly extractor?: Record<string, unknown>;
  readonly tierPolicy?: TierPolicy;
}

const createWatchBodySchema = {
  type: 'object',
  required: ['kind', 'url', 'schedule', 'condition'],
  // Rejecting unknown keys is how a typo in a chat tool call or a dashboard
  // form surfaces as a 400 instead of a watch that silently ignores half of
  // what the caller asked for.
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: [...WATCH_KINDS] },
    url: { type: 'string', format: 'http-url', maxLength: 2048 },
    schedule: { type: 'string', format: 'cron-expression' },
    condition: { type: 'object' },
    extractor: { type: 'object' },
    tierPolicy: { type: 'string', enum: [...TIER_POLICIES] },
  },
} as const;

const pauseWatchBodySchema = {
  type: 'object',
  required: ['status'],
  additionalProperties: false,
  properties: { status: { type: 'string', enum: [...WATCH_STATUSES] } },
} as const;

const watchIdParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

export function registerWatchRoutes(app: FastifyInstance): void {
  app.post(
    '/watches',
    { schema: { headers: callerHeaderSchema, body: createWatchBodySchema }, preHandler: resolveCaller },
    async (request: FastifyRequest<{ Body: CreateWatchBody }>, reply) => {
      const body = request.body;
      // The schema above settles the shape; the engine's own door settles the
      // meaning - a threshold the comparator could act on, a schedule above
      // the frequency floor, an extractor that reads this kind of value. A
      // watch that passed only the first would be stored and never fire,
      // which is the one failure a person cannot see from the outside.
      const violations = watchConfigViolations(body);
      if (violations.length > 0) {
        throw new HttpError(
          400,
          'validation_failed',
          'The watch does not describe a check the engine can run.',
          violations,
        );
      }

      const [created] = await app.db
        .insert(watches)
        .values({
          userId: request.userId,
          kind: body.kind,
          url: body.url,
          schedule: body.schedule,
          condition: body.condition,
          // A watch with no extractor is one the model writes an extractor
          // for on its first check.
          extractor: body.extractor ?? {},
          ...(body.tierPolicy === undefined ? {} : { tierPolicy: body.tierPolicy }),
        })
        .returning();
      return reply.status(201).send(created);
    },
  );

  app.get(
    '/watches',
    { schema: { headers: callerHeaderSchema }, preHandler: resolveCaller },
    async (request) =>
      // No creation timestamp exists on `watches` in ARCHITECTURE §5, so the
      // order is by id: arbitrary but stable, rather than whatever the planner
      // happened to return.
      app.db
        .select()
        .from(watches)
        .where(eq(watches.userId, request.userId))
        .orderBy(asc(watches.id)),
  );

  app.patch(
    '/watches/:id',
    {
      schema: {
        headers: callerHeaderSchema,
        params: watchIdParamsSchema,
        body: pauseWatchBodySchema,
      },
      preHandler: resolveCaller,
    },
    async (request: FastifyRequest<{ Params: { id: string }; Body: { status: WatchStatus } }>) => {
      const [updated] = await app.db
        .update(watches)
        .set({ status: request.body.status })
        // Scoping the update by owner as well as id means another user's watch
        // is not merely hidden from the response: it is never written.
        .where(and(eq(watches.id, request.params.id), eq(watches.userId, request.userId)))
        .returning();
      if (updated === undefined) {
        throw new HttpError(404, 'not_found', `No watch ${request.params.id} belongs to you.`);
      }
      return updated;
    },
  );

  /**
   * The one way down the tier ladder. The floor a watch learned only ever
   * rises on its own (tiered-fetching spec), because a site that refused
   * plain HTTP once will refuse it again; when a person has reason to think
   * otherwise - the site changed, or the watch was moved - this is how they
   * say so. It is an action rather than a field on PATCH because there is
   * exactly one value to set it to, and because `health` comes with it: the
   * verdict the ladder reached at the old floor is not a verdict about the
   * new one. What the last check found (`lastError`, the failure count) is
   * left as it was, because it is still what the last check found.
   */
  app.post(
    '/watches/:id/tier-reset',
    { schema: { headers: callerHeaderSchema, params: watchIdParamsSchema }, preHandler: resolveCaller },
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const [updated] = await app.db
        .update(watches)
        .set({ tierFloor: 'http', health: 'healthy' })
        .where(and(eq(watches.id, request.params.id), eq(watches.userId, request.userId)))
        .returning();
      if (updated === undefined) {
        throw new HttpError(404, 'not_found', `No watch ${request.params.id} belongs to you.`);
      }
      return updated;
    },
  );
}
