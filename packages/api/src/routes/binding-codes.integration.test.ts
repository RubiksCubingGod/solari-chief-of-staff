import { isBindingCode, normalizeBindingCode } from '@chief-of-staff/core';
import { bindingCodes, runMigrations, users } from '@chief-of-staff/db';
import { startTestPostgres, type TestPostgres } from '@chief-of-staff/db/testing';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { BINDING_CODE_TTL_MS } from './binding-codes.js';

/**
 * Issuing half of ARCHITECTURE §10's binding. The redeeming half lives in the
 * bot, and the two meet at `@chief-of-staff/core`'s code format: what this
 * route hands out has to be something `/start` will accept back.
 */

let postgres: TestPostgres;
let app: FastifyInstance;
let ownerId: string;

interface IssuedCode {
  readonly code: string;
  readonly expiresAt: string;
}

async function issue(userId: string): Promise<{ status: number; body: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/binding-codes',
    headers: { 'x-user-id': userId },
  });
  return { status: response.statusCode, body: response.body };
}

beforeAll(async () => {
  postgres = await startTestPostgres();
  await runMigrations(postgres.connectionString);
  app = createApp({ DATABASE_URL: postgres.connectionString, LOG_LEVEL: 'silent' });
  await app.ready();
  const [created] = await app.db.insert(users).values({}).returning();
  if (created === undefined) throw new Error('the fixture user was not created');
  ownerId = created.id;
});

afterAll(async () => {
  try {
    await app.close();
  } finally {
    await postgres.stop();
  }
});

beforeEach(async () => {
  await app.db.delete(bindingCodes);
});

describe('POST /binding-codes', () => {
  it('issues a code the bot will recognize, and stores it unconsumed', async () => {
    const before = Date.now();
    const response = await issue(ownerId);
    const issued = JSON.parse(response.body) as IssuedCode;

    expect(response.status).toBe(201);
    // The whole point of the shared format: what comes back here is what
    // `/start` accepts, without either side re-deriving the rules.
    expect(isBindingCode(issued.code)).toBe(true);
    expect(normalizeBindingCode(issued.code)).toBe(issued.code);

    const [stored] = await app.db
      .select()
      .from(bindingCodes)
      .where(eq(bindingCodes.code, issued.code));
    expect(stored?.userId).toBe(ownerId);
    expect(stored?.consumedAt).toBeNull();
    expect(new Date(issued.expiresAt).getTime()).toBeGreaterThanOrEqual(
      before + BINDING_CODE_TTL_MS,
    );
  });

  it('issues a different code every time, so an old one cannot be replayed', async () => {
    const first = (JSON.parse((await issue(ownerId)).body) as IssuedCode).code;
    const second = (JSON.parse((await issue(ownerId)).body) as IssuedCode).code;

    expect(first).not.toBe(second);
    // Both live: issuing a code is not a revocation of the last, because the
    // person who lost the first one is exactly who asks for a second.
    expect(await app.db.select().from(bindingCodes)).toHaveLength(2);
  });

  it('refuses a caller who is not a user, without issuing anything', async () => {
    const response = await issue('11111111-1111-4111-8111-111111111111');

    expect(response.status).toBe(404);
    expect(await app.db.select().from(bindingCodes)).toHaveLength(0);
  });

  it('refuses a caller who names no user at all', async () => {
    const response = await app.inject({ method: 'POST', url: '/binding-codes' });

    expect(response.statusCode).toBe(400);
    expect(await app.db.select().from(bindingCodes)).toHaveLength(0);
  });
});
