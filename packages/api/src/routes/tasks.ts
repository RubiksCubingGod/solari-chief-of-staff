import { TASK_KINDS, TASK_MODES } from '@chief-of-staff/core';
import type { TaskKind, TaskMode } from '@chief-of-staff/core';
import { tasks } from '@chief-of-staff/db';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { callerHeaderSchema, resolveCaller } from '../caller.js';
import { HttpError } from '../errors.js';

/**
 * Creating a task queues it and stops there: the action engine that runs one is
 * sprint `action-playbooks`. That is the whole reason this route exists now —
 * the chat loop has to be able to say "I have queued that" and have the words
 * be true, which needs a row and needs nothing else.
 */
interface CreateTaskBody {
  readonly kind: TaskKind;
  readonly input: Record<string, unknown>;
  readonly mode?: TaskMode;
}

const createTaskBodySchema = {
  type: 'object',
  required: ['kind', 'input'],
  // No `status`, no `result`, no `finishedAt`: everything after `queued` is the
  // engine's to write. A body that could name a status would let the chat loop
  // mark its own work done without doing any.
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: [...TASK_KINDS] },
    input: { type: 'object' },
    mode: { type: 'string', enum: [...TASK_MODES] },
  },
} as const;

/**
 * What a caller who does not say gets. ARCHITECTURE §3.2 tries a recorded
 * playbook before spending an agentic run, so the cheaper of the two is the
 * honest default rather than the more capable one.
 */
export const DEFAULT_TASK_MODE: TaskMode = 'playbook';

const taskIdParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

export function registerTaskRoutes(app: FastifyInstance): void {
  app.post(
    '/tasks',
    {
      schema: { headers: callerHeaderSchema, body: createTaskBodySchema },
      preHandler: resolveCaller,
    },
    async (request: FastifyRequest<{ Body: CreateTaskBody }>, reply) => {
      const body = request.body;
      const [created] = await app.db
        .insert(tasks)
        .values({
          userId: request.userId,
          kind: body.kind,
          input: body.input,
          mode: body.mode ?? DEFAULT_TASK_MODE,
        })
        .returning();
      return reply.status(201).send(created);
    },
  );

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
