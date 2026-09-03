import { describeRefusal } from '../../../../api-refusal';
import { connectClientForCookie } from '../../../../connect/client';
import { connectPathWithOutcome, type ConnectOutcome } from '../../../../connect/connect-outcome';

/**
 * The reader's word that the profile now holds their login. The API writes the
 * row on it; this route only carries it there and reports back with a token,
 * for the reasons `watches/pause/route.ts` gives.
 */
export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const client = connectClientForCookie(request.headers.get('cookie') ?? '');

  try {
    await client.confirmAttempt(id);
  } catch (error) {
    describeRefusal(error);
    return backToTheList('failed');
  }

  return backToTheList('connected');
}

function backToTheList(outcome: ConnectOutcome): Response {
  return new Response(null, { status: 303, headers: { location: connectPathWithOutcome(outcome) } });
}
