import { users } from '@chief-of-staff/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';

import {
  LOGIN_TOKEN_TTL_MS,
  SESSION_TTL_MS,
  clearedSessionCookieHeader,
  sessionCookieHeader,
  signSession,
} from '../auth/session.js';
import { consumeLoginToken, issueLoginToken } from '../auth/tokens.js';
import { callerHeaderSchema, resolveCaller } from '../caller.js';
import { HttpError } from '../errors.js';

/**
 * The magic-link flow: request a link, follow it, end the session.
 *
 * There is no password anywhere in here, and deliberately no account creation
 * either. A link is only ever issued to an address that already names a row, so
 * this is the door to an account rather than a way to open one — which is what
 * lets `POST /auth/request-link` answer a stranger and a user identically
 * without that answer being a lie in either direction.
 */

/**
 * The one thing `POST /auth/request-link` ever says, whoever asked and whatever
 * was found.
 *
 * A frozen constant rather than an object literal per branch, because the
 * guarantee is byte-identity: two literals that differ by a key order, a word
 * or a trailing field would each be a way to ask this server whether an address
 * has an account here. Held here so the branches below cannot drift apart.
 */
const ACCEPTED = Object.freeze({
  status: 'accepted',
  message: 'If that address has an account, a sign-in link is on its way to it.',
});

const requestLinkSchema = {
  type: 'object',
  required: ['email'],
  // No stray fields: a `redirectTo` somebody added to the form would be an open
  // redirect if a later version ever read it, and refusing it now costs nothing.
  additionalProperties: false,
  properties: {
    email: {
      type: 'string',
      // `email` comes from ajv-formats, which Fastify compiles schemas through.
      // It is deliberately not one of the formats in `formats.ts`: a custom one
      // of the same name would be silently overridden by it (see the note on
      // `iso-instant` there), so the shared one is named on purpose.
      format: 'email',
      // The longest address RFC 5321 permits. A ceiling here means a megabyte
      // of "address" is refused by the schema rather than digested by a handler.
      maxLength: 320,
    },
  },
} as const;

const callbackSchema = {
  type: 'object',
  required: ['token'],
  properties: {
    token: { type: 'string', minLength: 1, maxLength: 512 },
  },
  // Additional query parameters are tolerated on purpose: mail clients and link
  // scanners append their own, and a link that stopped working because
  // something added `utm_source` would look exactly like an expired one.
} as const;

/** A redirect with no body, which is all a browser following a link needs. */
function seeOther(reply: FastifyReply, location: string): FastifyReply {
  // 303 rather than 302: it tells the browser to GET the destination, which is
  // what `POST /auth/logout` needs and what the callback wants anyway.
  return reply.status(303).header('location', location).send();
}

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post(
    '/auth/request-link',
    { schema: { body: requestLinkSchema } },
    async (request, reply) => {
      const { email } = request.body as { email: string };
      // Compared in lower case because a person typing their own address does
      // not think of it as case sensitive, and the column is written normalised.
      const address = email.trim().toLowerCase();

      const [account] = await app.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, address))
        .limit(1);

      if (account !== undefined) {
        const issued = await issueLoginToken(app.db, account.id, LOGIN_TOKEN_TTL_MS);
        await app.mailer.send({
          to: address,
          // Built from the configured public origin rather than from the
          // request's own `Host`, which a caller controls: a link built from an
          // attacker's header would arrive in a real inbox pointing at their
          // server, carrying a real token.
          link: `${app.auth.apiPublicUrl}/auth/callback?token=${encodeURIComponent(issued.token)}`,
          expiresAt: issued.expiresAt,
        });
      }

      // The same answer either way. The work above is skipped for an address
      // nobody holds, so the two paths differ in how long they take; closing
      // that gap would mean issuing tokens for addresses that do not exist, and
      // the timing of a single unauthenticated request is a far weaker signal
      // than a body that says "no such user".
      return reply.status(202).send(ACCEPTED);
    },
  );

  app.get('/auth/callback', { schema: { querystring: callbackSchema } }, async (request, reply) => {
    const { token } = request.query as { token: string };
    const userId = await consumeLoginToken(app.db, token);

    if (userId === undefined) {
      // Expired, already spent, tampered with, never issued: one answer for all
      // four, and no cookie. The dashboard turns `invalid_link` into "that link
      // has been used or has expired — here is a fresh one".
      return seeOther(reply, `${app.auth.dashboardBaseUrl}/login?error=invalid_link`);
    }

    const session = signSession(
      userId,
      app.auth.sessionSecret,
      new Date(Date.now() + SESSION_TTL_MS),
    );
    reply.header(
      'set-cookie',
      sessionCookieHeader(session, {
        domain: app.auth.cookieDomain,
        secure: app.auth.cookieSecure,
        maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
      }),
    );
    return seeOther(reply, `${app.auth.dashboardBaseUrl}/`);
  });

  app.post('/auth/logout', (_request, reply) => {
    // No session required and none checked. A logout that refused a request
    // carrying nothing would strand exactly the person it is meant to help: the
    // one whose cookie is already unreadable.
    reply.header(
      'set-cookie',
      clearedSessionCookieHeader({
        domain: app.auth.cookieDomain,
        secure: app.auth.cookieSecure,
      }),
    );
    return seeOther(reply, `${app.auth.dashboardBaseUrl}/login`);
  });

  app.get(
    '/auth/session',
    { schema: { headers: callerHeaderSchema }, preHandler: resolveCaller },
    async (request) => {
      const [account] = await app.db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.id, request.userId))
        .limit(1);
      // `resolveCaller` already found this row; a delete between the two is the
      // only way here, and it is the same "not signed in" as any other.
      if (account === undefined) {
        throw new HttpError(401, 'unauthorized', 'This request carries no valid session.');
      }
      return account;
    },
  );
}
