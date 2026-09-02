import { TASK_KINDS, TASK_MODES } from '@chief-of-staff/core';
import type { TaskKind, TaskMode } from '@chief-of-staff/core';
import { taskEvents, tasks } from '@chief-of-staff/db';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { callerHeaderSchema, resolveCaller } from '../caller.js';
import { HttpError } from '../errors.js';
import { NDJSON_CONTENT_TYPE, RecordingUnavailableError, fetchRecording } from '../recording.js';

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

/** Where a task's recording is served from, for a task that has one. */
export function recordingPath(id: string): string {
  return `/tasks/${encodeURIComponent(id)}/recording`;
}

/**
 * The caller's task, or the refusal. Scoped by owner as well as id, so a task
 * belonging to somebody else is answered exactly as a task that never existed.
 */
async function ownedTask(
  app: FastifyInstance,
  id: string,
  userId: string,
): Promise<typeof tasks.$inferSelect> {
  const [found] = await app.db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, id), eq(tasks.userId, userId)))
    .limit(1);
  if (found === undefined) {
    throw new HttpError(404, 'not_found', `No task ${id} belongs to you.`);
  }
  return found;
}

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
      const found = await ownedTask(app, request.params.id, request.userId);
      // Oldest first, by the sequence the ledger assigned as it wrote: the
      // detail page tells the story in the order it happened, and a timestamp
      // cannot order two events written inside the same millisecond.
      const events = await app.db
        .select({
          seq: taskEvents.seq,
          ts: taskEvents.ts,
          type: taskEvents.type,
          payload: taskEvents.payload,
        })
        .from(taskEvents)
        .where(eq(taskEvents.taskId, found.id))
        .orderBy(asc(taskEvents.seq));
      return {
        ...found,
        events,
        // A reference rather than an address: the page fetches the recording
        // through the route below, which settles ownership and encoding, and
        // never has to know where the bytes live or how the store keeps them.
        recording:
          found.recordingUrl === null
            ? { available: false }
            : { available: true, href: recordingPath(found.id) },
      };
    },
  );

  app.get(
    '/tasks/:id/recording',
    {
      schema: { headers: callerHeaderSchema, params: taskIdParamsSchema },
      preHandler: resolveCaller,
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const found = await ownedTask(app, request.params.id, request.userId);
      if (found.recordingUrl === null) {
        throw new HttpError(404, 'not_found', `Task ${found.id} has no recording.`);
      }
      let recording: string;
      try {
        recording = await fetchRecording(found.recordingUrl);
      } catch (error) {
        if (!(error instanceof RecordingUnavailableError)) throw error;
        request.log.warn({ err: error, taskId: found.id }, 'the recording store let a reader down');
        throw new HttpError(
          502,
          'upstream_unavailable',
          'The recording could not be fetched from its store.',
        );
      }
      // Private and uncached: the body was fetched with the caller's ownership
      // settled, and a shared cache would hand it to the next caller without.
      return reply
        .header('content-type', NDJSON_CONTENT_TYPE)
        .header('cache-control', 'private, no-store')
        .send(recording);
    },
  );
}
