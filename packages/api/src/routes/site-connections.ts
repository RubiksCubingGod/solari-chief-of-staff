import {
  expireSiteConnection,
  linkSiteConnection,
  listSiteConnections,
  readOwnedSiteConnection,
  type SiteConnection,
} from '@chief-of-staff/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { callerHeaderSchema, resolveCaller } from '../caller.js';
import type { ConnectAttempt } from '../connect-attempts.js';
import { HttpError } from '../errors.js';

/**
 * Connecting a site: the routes behind the dashboard's connect page and the
 * chat tool of the same name.
 *
 * The shape follows from one vendor fact, argued in `solari/profiles.ts`: the
 * only way a person can put a login into a browser profile is the vendor
 * console's own editor, and nothing mints a link into it. So an attempt here
 * mints an empty profile with a name the person can find, tells them where the
 * console's profile list is, and waits. Confirming is the person's word that
 * the profile now holds their session; the row is written on that word, and a
 * task that later finds the session dead flips the row back to `expired`
 * through the playbook runner, which is the check that keeps the word honest.
 *
 * No credential passes through this server, in either direction. A body with
 * a password in it has no field to land in and is refused by the schema.
 */

interface StartBody {
  readonly siteDomain: string;
}

interface PatchBody {
  readonly status: 'expired';
}

const startBodySchema = {
  type: 'object',
  required: ['siteDomain'],
  additionalProperties: false,
  properties: { siteDomain: { type: 'string', minLength: 1, maxLength: 260 } },
} as const;

const patchBodySchema = {
  type: 'object',
  required: ['status'],
  additionalProperties: false,
  // The one transition a person may ask for by hand: a connection they know
  // is dead. `connected` is only ever earned through an attempt.
  properties: { status: { type: 'string', enum: ['expired'] } },
} as const;

const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
} as const;

const connectionIdParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

/**
 * A host as a browser would print it: lowercase, no scheme, no path, no
 * credentials, an optional port. Settled by parsing rather than by pattern,
 * so the notion of "host" is the URL standard's and not this file's.
 */
function normaliseSiteDomain(value: string): string {
  const candidate = value.trim().toLowerCase();
  const refusal = new HttpError(400, 'validation_failed', 'The request did not match the schema for this route.', [
    { path: '/siteDomain', message: 'must be a bare host such as gym.example.com, with no scheme or path' },
  ]);
  let parsed: URL;
  try {
    parsed = new URL(`http://${candidate}`);
  } catch {
    throw refusal;
  }
  if (parsed.host !== candidate || parsed.host === '') throw refusal;
  return candidate;
}

/** What the API says about a connection. The profile id is the server's business. */
function presentConnection(connection: SiteConnection) {
  return {
    id: connection.id,
    siteDomain: connection.siteDomain,
    status: connection.status,
    lastUsedAt: connection.lastUsedAt,
  };
}

export function registerSiteConnectionRoutes(app: FastifyInstance): void {
  function presentAttempt(attempt: ConnectAttempt) {
    return {
      id: attempt.id,
      siteDomain: attempt.siteDomain,
      status: attempt.status,
      profileName: attempt.profile.name,
      editorUrl: app.connect.editorUrl,
      confirmUrl: `${app.auth.dashboardBaseUrl}/connect/${attempt.id}`,
      startedAt: attempt.startedAt.toISOString(),
      expiresAt: attempt.expiresAt.toISOString(),
    };
  }

  /** The ledger, or the one refusal that says why there is none. */
  function attempts() {
    const ledger = app.connect.attempts;
    if (ledger === undefined) {
      throw new HttpError(
        503,
        'upstream_unavailable',
        'Connecting a site needs the browser vendor: SOLARI_API_KEY is not set on the server.',
      );
    }
    return ledger;
  }

  app.post(
    '/site-connections/attempts',
    { schema: { headers: callerHeaderSchema, body: startBodySchema }, preHandler: resolveCaller },
    async (request: FastifyRequest<{ Body: StartBody }>, reply) => {
      const siteDomain = normaliseSiteDomain(request.body.siteDomain);
      const ledger = attempts();
      let attempt: ConnectAttempt;
      try {
        attempt = await ledger.start(request.userId, siteDomain);
      } catch (error) {
        // The only thing starting an attempt does that can fail is ask the
        // vendor for a profile, so whatever came back is the vendor's refusal,
        // typed or not. Its words go in the body: a plan at its cap or a
        // refused key is something an operator acts on, and the sentence is
        // what tells them which.
        const reason = error instanceof Error ? error.message : String(error);
        throw new HttpError(503, 'upstream_unavailable', `The browser vendor refused to create a profile: ${reason}`);
      }
      return reply.status(201).send(presentAttempt(attempt));
    },
  );

  app.get(
    '/site-connections/attempts/:id',
    { schema: { headers: callerHeaderSchema, params: idParamsSchema }, preHandler: resolveCaller },
    (request: FastifyRequest<{ Params: { id: string } }>) => {
      const attempt = attempts().read(request.userId, request.params.id);
      if (attempt === undefined) throw new HttpError(404, 'not_found', 'That connect attempt does not exist.');
      return presentAttempt(attempt);
    },
  );

  app.post(
    '/site-connections/attempts/:id/confirm',
    { schema: { headers: callerHeaderSchema, params: idParamsSchema }, preHandler: resolveCaller },
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      let linked: SiteConnection | undefined;
      let replaced: string | undefined;
      const attempt = await attempts().confirm(request.userId, request.params.id, async (open) => {
        const result = await linkSiteConnection(app.db, {
          userId: open.userId,
          siteDomain: open.siteDomain,
          solariProfileId: open.profile.id,
        });
        linked = result.connection;
        replaced = result.replacedProfileId;
      });
      if (attempt === undefined || linked === undefined) {
        throw new HttpError(404, 'not_found', 'That connect attempt is not open.');
      }
      if (replaced !== undefined) {
        // The row no longer names it, so nothing can use it; keeping it would
        // only count against the plan. Best effort, like every other clean-up.
        await app.connect.store?.delete(replaced).catch((error: unknown) => {
          request.log.warn({ err: error }, 'could not delete the replaced profile');
        });
      }
      return presentConnection(linked);
    },
  );

  app.delete(
    '/site-connections/attempts/:id',
    { schema: { headers: callerHeaderSchema, params: idParamsSchema }, preHandler: resolveCaller },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const cancelled = await attempts().cancel(request.userId, request.params.id);
      if (!cancelled) throw new HttpError(404, 'not_found', 'That connect attempt is not open.');
      return reply.status(204).send();
    },
  );

  app.get(
    '/site-connections',
    { schema: { headers: callerHeaderSchema }, preHandler: resolveCaller },
    async (request) => {
      const rows = await listSiteConnections(app.db, request.userId);
      return rows.map(presentConnection);
    },
  );

  app.patch(
    '/site-connections/:id',
    {
      schema: { headers: callerHeaderSchema, params: connectionIdParamsSchema, body: patchBodySchema },
      preHandler: resolveCaller,
    },
    async (request: FastifyRequest<{ Params: { id: string }; Body: PatchBody }>) => {
      const owned = await readOwnedSiteConnection(app.db, request.userId, request.params.id);
      if (owned === undefined) throw new HttpError(404, 'not_found', 'That site connection does not exist.');
      const expired = await expireSiteConnection(app.db, owned.id);
      if (expired === undefined) throw new HttpError(404, 'not_found', 'That site connection does not exist.');
      return presentConnection(expired);
    },
  );
}
