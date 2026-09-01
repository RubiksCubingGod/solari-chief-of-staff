import { tasks } from '@chief-of-staff/db';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { callerHeaderSchema, resolveCaller } from '../caller.js';
import { HttpError } from '../errors.js';

/**
 * Tasks are read-only here. Rows are created by the action engine in a later
 * sprint; these routes exist so the dashboard and the chat tools can render a
 * task history against the real substrate before that engine is written.
 */
const taskIdParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

export function registerTaskRoutes(app: FastifyInstance): void {
  app.get(
    '/tasks',
    { schema: { headers: callerHeaderSchema }, preHandler: resolveCaller },
    async (request) =>
      app.db
        .select()
        .from(tasks)
        .where(eq(tasks.userId, request.userId))
        .orderBy(desc(tasks.createdAt), desc(tasks.id)),
  );

  app.get(
    '/tasks/:id',
    {
      schema: { headers: callerHeaderSchema, params: taskIdParamsSchema },
      preHandler: resolveCaller,
    },
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const [found] = await app.db
        .select()
        .from(tasks)
        // Scoped by owner as well as id, so a task belonging to somebody else
        // is answered exactly as a task that never existed.
        .where(and(eq(tasks.id, request.params.id), eq(tasks.userId, request.userId)))
        .limit(1);
      if (found === undefined) {
        throw new HttpError(404, 'not_found', `No task ${request.params.id} belongs to you.`);
      }
      // The row and nothing else: the step timeline and the replay embed that
      // hang off a task are the action-playbooks sprint's, and joining them in
      // here would make this read wait on tables the history shell never draws.
      return found;
    },
  );
}
