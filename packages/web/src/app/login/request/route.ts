import { ApiError, anonymousCredential, createApiClient } from '../../../api-client';
import { loadWebConfig } from '../../../config';

/**
 * Where the sign-in form posts.
 *
 * Same origin on purpose. The form could post straight at the API, but that is
 * a cross-origin write from a browser, which means either CORS or a form
 * encoding the API does not accept - and both are machinery in exchange for
 * nothing. Here the browser talks to the page it is already on, and the server
 * talks to the API.
 */
export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const email = form.get('email');

  if (typeof email === 'string' && email.trim() !== '') {
    const client = createApiClient({
      baseUrl: loadWebConfig().apiBaseUrl,
      credential: anonymousCredential,
    });
    try {
      await client.requestLink(email.trim());
    } catch (error: unknown) {
      // A refusal is swallowed on purpose: the API answers a known and an
      // unknown address identically, and a page that turned a 400 into "no such
      // address" would hand back exactly the answer the API withheld. The only
      // thing a visitor is ever told is the sentence below.
      if (!(error instanceof ApiError)) throw error;
    }
  }

  // 303 so the browser follows with a GET; a refresh of the confirmation then
  // reloads a page rather than re-posting the form.
  return new Response(null, {
    status: 303,
    headers: { location: new URL('/login?sent=1', request.url).toString() },
  });
}
