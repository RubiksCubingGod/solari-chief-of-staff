import { randomInt } from 'node:crypto';

import { BINDING_CODE_ALPHABET, BINDING_CODE_LENGTH } from '@chief-of-staff/core';
import { bindingCodes } from '@chief-of-staff/db';
import type { FastifyInstance } from 'fastify';

import { callerHeaderSchema, resolveCaller } from '../caller.js';

/**
 * How long an issued code lives. Long enough to read it off a dashboard and
 * type it into Telegram without hurrying, short enough that a code left on a
 * screen somebody walked away from is not a standing invitation.
 */
export const BINDING_CODE_TTL_MS = 10 * 60 * 1000;

/**
 * A fresh code. `randomInt` rather than `Math.random` because this value is the
 * only thing standing between a stranger and somebody else's account, and it
 * draws uniformly rather than taking a modulus, which would quietly favour the
 * front of the alphabet.
 */
function generateBindingCode(): string {
  return Array.from({ length: BINDING_CODE_LENGTH }, () =>
    BINDING_CODE_ALPHABET[randomInt(BINDING_CODE_ALPHABET.length)],
  ).join('');
}

export function registerBindingCodeRoutes(app: FastifyInstance): void {
  app.post(
    '/binding-codes',
    { schema: { headers: callerHeaderSchema }, preHandler: resolveCaller },
    async (request, reply) => {
      const [created] = await app.db
        .insert(bindingCodes)
        .values({
          userId: request.userId,
          code: generateBindingCode(),
          expiresAt: new Date(Date.now() + BINDING_CODE_TTL_MS),
        })
        // Only the two fields the holder needs. The row's id is not among them:
        // nothing redeems by id, and handing one out would invite something to.
        .returning({ code: bindingCodes.code, expiresAt: bindingCodes.expiresAt });
      // An insert that returned nothing is a 500, not a 201 carrying an empty
      // object that a dashboard would render as a blank code.
      if (created === undefined) throw new Error('the binding code was not issued');
      return reply.status(201).send(created);
    },
  );
}
