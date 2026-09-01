import { users } from '@chief-of-staff/db';
import { eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';

import { HttpError } from './errors.js';

/**
 * Until the dashboard's magic-link auth arrives (sprint `dashboard-read`), the
 * caller names itself in a header. The identity is deliberately not part of any
 * request body: when real authentication lands it replaces this hook alone, and
 * every route schema stays exactly as it is.
 */
export const CALLER_HEADER = 'x-user-id';

export const callerHeaderSchema = {
  type: 'object',
  required: [CALLER_HEADER],
  properties: { [CALLER_HEADER]: { type: 'string', format: 'uuid' } },
} as const;

/**
 * Resolves the header to a user that exists. Checking here rather than letting
 * a foreign key fail means an unknown caller is refused identically whether the
 * route reads or writes, and a refused write never reaches an INSERT.
 */
export async function resolveCaller(request: FastifyRequest): Promise<void> {
  const header = request.headers[CALLER_HEADER];
  const id = typeof header === 'string' ? header : '';
  const found = await request.server.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (found.length === 0) {
    throw new HttpError(404, 'not_found', `No user matches the ${CALLER_HEADER} header.`);
  }
  request.userId = id;
}
