import { tasks } from '@chief-of-staff/db';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import { callerHeaderSchema, resolveCaller } from '../caller.js';

/**
 * Tasks are read-only here. Rows are created by the action engine in a later
 * sprint; this route exists so the dashboard and the chat tools can render a
 * task list against the real substrate before that engine is written.
 */
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
}
