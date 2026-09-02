import { and, eq } from 'drizzle-orm';

import { siteConnections, type SiteConnection } from './schema.js';
import type { TaskDatabase } from './task-ledger.js';

/**
 * The user's connection to a site, by the domain it was made for. The schema
 * allows one per user and domain, so this is a lookup and not a choice.
 */
export async function readSiteConnection(
  db: TaskDatabase,
  userId: string,
  siteDomain: string,
): Promise<SiteConnection | undefined> {
  const [connection] = await db
    .select()
    .from(siteConnections)
    .where(and(eq(siteConnections.userId, userId), eq(siteConnections.siteDomain, siteDomain)));
  return connection;
}
