import { ApiError, createApiClient, sessionCookieCredential } from '../../../../api-client';
import { describeRefusal } from '../../../../api-refusal';
import { loadWebConfig } from '../../../../config';

/**
 * The recording, served to the player by the page it is on.
 *
 * Same origin, like the sign-in form and the pause control, and for the same
 * reasons: the browser asks the page it is already on, the server asks the
 * API, and the session travels as the browser's own cookie, forwarded unread.
 * The API settles ownership, so this route cannot hand over a recording the
 * person driving it may not see even if asked to, and it undoes whatever the
 * store did to the bytes, so what leaves here is NDJSON or a status.
 *
 * Every exit is something the player can read: the recording when the API had
 * it, and otherwise a status with a sentence, which the player turns into the
 * error state beside a timeline that still renders. Nothing here throws for a
 * refusal, because a route handler that throws renders Next's blank 500.
 */
interface RecordingRouteContext {
  readonly params: Promise<{ readonly id: string }>;
}

/** The body was fetched with one person's ownership settled; no cache may reuse it. */
const PRIVATE = { 'cache-control': 'private, no-store' } as const;

export async function GET(request: Request, context: RecordingRouteContext): Promise<Response> {
  const { id } = await context.params;
  const client = createApiClient({
    baseUrl: loadWebConfig().apiBaseUrl,
    credential: sessionCookieCredential(request.headers.get('cookie') ?? ''),
  });

  let recording: string;
  try {
    recording = await client.readTaskRecording(id);
  } catch (error) {
    if (error instanceof ApiError) return refusal(error.status, error.message);
    // Classified, not swallowed: `describeRefusal` names an API that did not
    // answer and rethrows anything else, so a defect still arrives as one.
    return refusal(502, describeRefusal(error));
  }

  return new Response(recording, {
    status: 200,
    headers: { ...PRIVATE, 'content-type': 'application/x-ndjson; charset=utf-8' },
  });
}

function refusal(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { ...PRIVATE, 'content-type': 'text/plain; charset=utf-8' },
  });
}
