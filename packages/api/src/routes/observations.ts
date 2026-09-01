import { observations, watches } from '@chief-of-staff/db';
import { and, desc, eq, gte, lt } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { callerHeaderSchema, resolveCaller } from '../caller.js';
import { HttpError } from '../errors.js';

/**
 * The observation series behind a dashboard sparkline. It lives apart from
 * `watches.ts` because it is the one route whose path names a watch but whose
 * rows come from another table, and because its window, ceiling and ordering
 * are a contract in their own right that would bury the watch CRUD it would
 * otherwise sit inside.
 */

/**
 * How long a series is when the caller names no length. A sparkline shows a
 * recent trend rather than a lifetime, and a default that always applies is
 * what keeps a request that names no bounds at all from being unbounded.
 */
const DEFAULT_OBSERVATION_LIMIT = 100;

interface ObservationQuery {
  readonly from?: string;
  readonly to?: string;
  readonly limit?: string;
}

const watchIdParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const observationQuerySchema = {
  type: 'object',
  // A misspelled bound would otherwise be dropped in silence and the caller
  // would be served a wider window than it asked for - the one way this route
  // could be wrong that a sparkline cannot show.
  additionalProperties: false,
  properties: {
    from: { type: 'string', format: 'iso-instant' },
    to: { type: 'string', format: 'iso-instant' },
    limit: { type: 'string', format: 'observation-limit' },
  },
} as const;

export function registerObservationRoutes(app: FastifyInstance): void {
  app.get(
    '/watches/:id/observations',
    {
      schema: {
        headers: callerHeaderSchema,
        params: watchIdParamsSchema,
        querystring: observationQuerySchema,
      },
      preHandler: resolveCaller,
    },
    async (
      request: FastifyRequest<{ Params: { id: string }; Querystring: ObservationQuery }>,
    ) => {
      const { from, to, limit } = request.query;
      const fromAt = from === undefined ? undefined : new Date(from);
      const toAt = to === undefined ? undefined : new Date(to);
      // Two bounds in the wrong order describe a window nothing can fall in.
      // Answering it with an empty series would read as "never checked" rather
      // than as the mistake it is, so it is refused instead. The comparison is
      // on instants rather than on the strings, which sort by their offset.
      if (fromAt !== undefined && toAt !== undefined && toAt.getTime() <= fromAt.getTime()) {
        throw new HttpError(
          400,
          'bad_request',
          'The `to` bound has to be later than the `from` bound.',
        );
      }

      const [owned] = await app.db
        .select({ id: watches.id })
        .from(watches)
        // Settling ownership by owner as well as id, before a single
        // observation is read, is what makes another user's watch answer
        // exactly as a watch that never existed: there is no series to filter
        // afterwards and nothing in the response to tell the two apart.
        .where(and(eq(watches.id, request.params.id), eq(watches.userId, request.userId)))
        .limit(1);
      if (owned === undefined) {
        throw new HttpError(404, 'not_found', `No watch ${request.params.id} belongs to you.`);
      }

      const newestFirst = await app.db
        .select()
        .from(observations)
        .where(
          and(
            eq(observations.watchId, request.params.id),
            fromAt === undefined ? undefined : gte(observations.checkedAt, fromAt),
            // Half-open, so two adjacent windows tile a history without either
            // losing an observation between them or counting one twice.
            toAt === undefined ? undefined : lt(observations.checkedAt, toAt),
          ),
        )
        // The ceiling has to keep the newest end of the series, so the read
        // walks the (watch_id, checked_at) index backwards and stops early.
        .orderBy(desc(observations.checkedAt), desc(observations.id))
        .limit(limit === undefined ? DEFAULT_OBSERVATION_LIMIT : Number(limit));
      // The response is then turned back around into the order a sparkline
      // plots: oldest on the left, newest on the right, so the page draws the
      // array as it arrives rather than reversing it itself.
      return newestFirst.reverse();
    },
  );
}
