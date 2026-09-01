import { taskEvents, tasks } from '@chief-of-staff/db';
import { and, eq, inArray } from 'drizzle-orm';

import { ANSWER_RECORDED, ASSISTANT_UNAVAILABLE, HOW_TO_BIND } from './replies.js';
import { resolveUserId, type BotDatabase } from './transcript.js';

/**
 * Where a message goes once the chat it came from has a user.
 *
 * There are exactly two destinations and a message reaches one of them. That
 * is the whole of this file, and both halves of it matter. Sending an answer to
 * the chat loop asks a model to act on "the annual one, please" as if it were
 * an instruction, which at best wastes a turn and at worst books something.
 * Sending a request to a waiting job files "cancel the gym too" as the answer
 * to a question about something else. And sending a message to neither loses
 * it in a way nobody can see: the user is left waiting on a reply that is
 * never coming, with a transcript that says their message arrived.
 */

/** What the chat loop is handed. The bot knows the user, so the loop need not. */
export interface ChatLoopRequest {
  readonly userId: string;
  readonly chatId: string;
  readonly text: string;
}

/**
 * The chat loop, as the bot needs it: words in, words out.
 *
 * A port rather than an import of `@chief-of-staff/agent`, because what the
 * loop needs to do its job — an API base URL, a model client, a key — is not
 * the bot's to hold, and because the composition sprint task wires the real one
 * in without this package growing a dependency on it.
 */
export interface ChatLoop {
  respond(request: ChatLoopRequest): Promise<string>;
}

/** A question a task has asked and is parked waiting on. */
export interface PendingQuestion {
  readonly taskId: string;
  readonly question: string;
}

/** One answer, with the question it answers, as the sink receives it. */
export interface QuestionAnswer {
  readonly userId: string;
  readonly taskId: string;
  readonly question: string;
  readonly text: string;
}

/**
 * Where an answer goes. In this sprint nothing reads what it writes — the task
 * engine that acts on a reply arrives later — so the sink is proven by the
 * record it leaves rather than by anything happening next.
 */
export interface AnswerSink {
  deliver(answer: QuestionAnswer): Promise<void>;
}

/** The event types that decide whether a task is waiting on an answer. */
const QUESTION_EVENTS = ['ask_user', 'user_reply'] as const;

/**
 * The question this user is currently being asked, or null when they are not
 * being asked anything.
 *
 * A task is waiting on an answer when it has asked one more time than it has
 * been answered. Counting rather than looking at the newest event is what makes
 * this independent of how two rows written in the same instant happen to sort,
 * and it stays right when a job asks a follow-up question after the first
 * answer.
 *
 * Only tasks that are actually parked are considered, so the rows this reads
 * are bounded by how many jobs one person has waiting at once, not by their
 * history.
 */
export async function findPendingQuestion(
  db: BotDatabase,
  userId: string,
): Promise<PendingQuestion | null> {
  const rows = await db
    .select({
      taskId: taskEvents.taskId,
      type: taskEvents.type,
      payload: taskEvents.payload,
      ts: taskEvents.ts,
    })
    .from(taskEvents)
    .innerJoin(tasks, eq(tasks.id, taskEvents.taskId))
    .where(
      and(
        eq(tasks.userId, userId),
        eq(tasks.status, 'waiting_user'),
        inArray(taskEvents.type, [...QUESTION_EVENTS]),
      ),
    );

  const asked = new Map<string, number>();
  const answered = new Map<string, number>();
  const newest = new Map<string, { question: string; ts: Date }>();
  for (const row of rows) {
    if (row.type === 'user_reply') {
      answered.set(row.taskId, (answered.get(row.taskId) ?? 0) + 1);
      continue;
    }
    const question = questionOf(row.payload);
    // An `ask_user` with nothing readable in it is not a question anybody can
    // answer, so it does not park the chat. The task stays waiting and the
    // user keeps talking to the loop, which is the harmless direction to be
    // wrong in.
    if (question === null) continue;
    asked.set(row.taskId, (asked.get(row.taskId) ?? 0) + 1);
    const seen = newest.get(row.taskId);
    if (seen === undefined || row.ts > seen.ts) newest.set(row.taskId, { question, ts: row.ts });
  }

  let pending: (PendingQuestion & { ts: Date }) | null = null;
  for (const [taskId, question] of newest) {
    if ((asked.get(taskId) ?? 0) <= (answered.get(taskId) ?? 0)) continue;
    // Two jobs waiting at once is a race nothing here can settle from the
    // words alone; the most recent question is the one the user is most
    // likely answering, and it is the one they can still see.
    if (pending === null || question.ts > pending.ts) {
      pending = { taskId, question: question.question, ts: question.ts };
    }
  }
  return pending === null ? null : { taskId: pending.taskId, question: pending.question };
}

/**
 * The sink the runtime uses when nothing else is supplied: the answer is
 * written onto the task's own timeline, beside the question it answers, which
 * is where the engine that asked will look for it.
 */
export function createTaskEventAnswerSink(db: BotDatabase): AnswerSink {
  return {
    async deliver(answer: QuestionAnswer): Promise<void> {
      await db.insert(taskEvents).values({
        taskId: answer.taskId,
        type: 'user_reply',
        payload: { text: answer.text },
      });
    },
  };
}

export interface RouteMessageOptions {
  readonly chatLoop: ChatLoop;
  readonly answerSink: AnswerSink;
}

/** One inbound message, with Telegram's part of it already taken off. */
export interface RoutedMessage {
  readonly chatId: string;
  readonly text: string;
}

/**
 * The router itself: one message in, the words to answer it with out.
 *
 * It returns the reply rather than sending it, and knows nothing about grammY,
 * because exactly one module in the workspace is allowed to call Telegram and
 * the transcript's completeness rests on that staying true. The runtime turns
 * this string into the one `ctx.reply` at the end of its middleware chain.
 *
 * It runs behind the binding gate, so the chat has a user; it re-reads that
 * user rather than being handed it, because the row can change between the two
 * reads - a chat rebound mid-message is rare and real, and answering the
 * previous owner's question with the new owner's words is the one outcome
 * worth a second query to avoid.
 */
export async function routeMessage(
  db: BotDatabase,
  options: RouteMessageOptions,
  message: RoutedMessage,
): Promise<string> {
  const userId = await resolveUserId(db, message.chatId);
  if (userId === null) return HOW_TO_BIND;

  try {
    const pending = await findPendingQuestion(db, userId);
    if (pending !== null) {
      await options.answerSink.deliver({
        userId,
        taskId: pending.taskId,
        question: pending.question,
        text: message.text,
      });
      return ANSWER_RECORDED;
    }
    const spoken = await options.chatLoop.respond({
      userId,
      chatId: message.chatId,
      text: message.text,
    });
    // A loop that answers with nothing has not answered. Telegram would refuse
    // the empty message anyway; this turns that into the same honest notice
    // every other failure here gets.
    return spoken === '' ? ASSISTANT_UNAVAILABLE : spoken;
  } catch {
    // Whatever broke, the person is owed an answer. A message that reached a
    // broken destination and got silence is indistinguishable, from where they
    // are sitting, from one that was never delivered at all.
    return ASSISTANT_UNAVAILABLE;
  }
}

/** The question text an `ask_user` payload carries, if it carries one at all. */
function questionOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const question = (payload as { question?: unknown }).question;
  return typeof question === 'string' && question !== '' ? question : null;
}
