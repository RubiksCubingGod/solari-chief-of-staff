import type { MessageDirection } from '@chief-of-staff/core';
import { messages, users, type Database } from '@chief-of-staff/db';
import { eq } from 'drizzle-orm';

export type BotDatabase = Database['db'];

export interface TranscriptEntry {
  readonly chatId: string;
  readonly direction: MessageDirection;
  readonly text: string;
}

/**
 * The user a Telegram chat is bound to, or null when the chat is bound to
 * nobody yet. Binding writes the row this reads (sprint task `account-binding`);
 * until then every chat resolves to null, which is a transcript row without an
 * owner rather than a message that goes unrecorded.
 */
export async function resolveUserId(db: BotDatabase, chatId: string): Promise<string | null> {
  const [found] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.telegramChatId, chatId))
    .limit(1);
  return found?.id ?? null;
}

/**
 * Writes one transcript row. Every message the bot handles — accepted, refused,
 * rate-limited, inbound or outbound — goes through here, which is what makes
 * the `messages` table a transcript rather than a sample of one.
 *
 * Telegram is the only channel there is, so `channel` is not a parameter; when
 * a second one arrives it becomes one, and the enum in
 * `@chief-of-staff/core` will refuse to let it be forgotten.
 */
export async function recordMessage(db: BotDatabase, entry: TranscriptEntry): Promise<void> {
  await db.insert(messages).values({
    userId: await resolveUserId(db, entry.chatId),
    chatId: entry.chatId,
    direction: entry.direction,
    channel: 'telegram',
    text: entry.text,
  });
}
