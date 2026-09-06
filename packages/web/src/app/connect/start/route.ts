import { ApiError } from '../../../api-client';
import { describeRefusal } from '../../../api-refusal';
import { connectClientForCookie } from '../../../connect/client';
import { connectPathWithOutcome, type ConnectOutcome } from '../../../connect/connect-outcome';

/**
 * Starting to connect a site: the API mints a profile and an attempt, and the
 * reader is sent to the attempt's page, where the console link and the
 * confirm button are.
 *
 * Same origin as the page, session forwarded unread, every exit a 303 with a
 * token - the pause control's design, and `watches/pause/route.ts` has the
 * argument for each part. One exit is this route's own: the API saying it has
 * no vendor to ask. That is not a refusal of what the reader typed, and the
 * list page says something different for it, so it travels as its own token.
 */
export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const typed = form.get('siteDomain');
  const siteDomain = typeof typed === 'string' ? typed.trim().toLowerCase() : '';
  if (siteDomain === '') return backToTheList('rejected');

  const client = connectClientForCookie(request.headers.get('cookie') ?? '');

  let id: string;
  try {
    ({ id } = await client.startAttempt(siteDomain));
  } catch (error) {
    describeRefusal(error);
    return backToTheList(notSwitchedOn(error) ? 'unavailable' : 'failed');
  }

  return new Response(null, {
    status: 303,
    headers: { location: `/connect/${encodeURIComponent(id)}` },
  });
}

/** The API's one refusal that no reader can do anything about. */
function notSwitchedOn(error: unknown): boolean {
  return error instanceof ApiError && error.status === 503 && error.code === 'upstream_unavailable';
}

function backToTheList(outcome: ConnectOutcome): Response {
  return new Response(null, { status: 303, headers: { location: connectPathWithOutcome(outcome) } });
}
