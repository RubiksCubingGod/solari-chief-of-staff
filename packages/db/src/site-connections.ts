import { and, asc, eq } from 'drizzle-orm';

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

/** Every connection the user holds, oldest domain first: the dashboard's list. */
export async function listSiteConnections(db: TaskDatabase, userId: string): Promise<SiteConnection[]> {
  return db
    .select()
    .from(siteConnections)
    .where(eq(siteConnections.userId, userId))
    .orderBy(asc(siteConnections.siteDomain));
}

/** One connection by id, and only if this user holds it. */
export async function readOwnedSiteConnection(
  db: TaskDatabase,
  userId: string,
  id: string,
): Promise<SiteConnection | undefined> {
  const [connection] = await db
    .select()
    .from(siteConnections)
    .where(and(eq(siteConnections.id, id), eq(siteConnections.userId, userId)));
  return connection;
}

export interface SiteConnectionLink {
  readonly userId: string;
  readonly siteDomain: string;
  readonly solariProfileId: string;
}

export interface LinkedSiteConnection {
  readonly connection: SiteConnection;
  /**
   * The profile the row named before, when re-linking swapped it out. The
   * caller owns deleting it at the vendor; this module knows nothing of that.
   */
  readonly replacedProfileId: string | undefined;
}

/**
 * Points the user's connection for a domain at a profile, minting the row on
 * the first connect and updating it on every reconnect. Either way the row
 * comes out `connected` with its last use cleared: a fresh login has no history.
 */
export async function linkSiteConnection(
  db: TaskDatabase,
  link: SiteConnectionLink,
): Promise<LinkedSiteConnection> {
  const previous = await readSiteConnection(db, link.userId, link.siteDomain);
  const [connection] = await db
    .insert(siteConnections)
    .values({
      userId: link.userId,
      siteDomain: link.siteDomain,
      solariProfileId: link.solariProfileId,
      status: 'connected',
      lastUsedAt: null,
    })
    .onConflictDoUpdate({
      target: [siteConnections.userId, siteConnections.siteDomain],
      set: { solariProfileId: link.solariProfileId, status: 'connected', lastUsedAt: null },
    })
    .returning();
  if (connection === undefined) throw new Error('linking a site connection returned no row');
  const replacedProfileId =
    previous !== undefined && previous.solariProfileId !== link.solariProfileId
      ? previous.solariProfileId
      : undefined;
  return { connection, replacedProfileId };
}

/**
 * Marks a connection expired: the site stopped honouring the profile's
 * session. The row and its profile id stay, so the dashboard can show what
 * needs redoing; only a new link makes it `connected` again.
 */
export async function expireSiteConnection(
  db: TaskDatabase,
  id: string,
): Promise<SiteConnection | undefined> {
  const [connection] = await db
    .update(siteConnections)
    .set({ status: 'expired' })
    .where(eq(siteConnections.id, id))
    .returning();
  return connection;
}
