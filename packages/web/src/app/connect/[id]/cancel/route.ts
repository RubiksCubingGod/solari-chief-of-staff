import { describeRefusal } from '../../../../api-refusal';
import { connectClientForCookie } from '../../../../connect/client';
import { connectPathWithOutcome, type ConnectOutcome } from '../../../../connect/connect-outcome';

/**
 * Giving up on an attempt. The API deletes the profile it minted; the reader
 * lands on the list told so. Shape and reasons as `watches/pause/route.ts`.
 */
export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const client = connectClientForCookie(request.headers.get('cookie') ?? '');

  try {
    await client.cancelAttempt(id);
  } catch (error) {
    describeRefusal(error);
    return backToTheList('failed');
  }

  return backToTheList('cancelled');
}

function backToTheList(outcome: ConnectOutcome): Response {
  return new Response(null, { status: 303, headers: { location: connectPathWithOutcome(outcome) } });
}
