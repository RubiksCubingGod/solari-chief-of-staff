import { headers } from 'next/headers';
import Link from 'next/link';

import { describeRefusal } from '../../../api-refusal';
import { connectClientForCookie, type ConnectAttempt } from '../../../connect/client';

/**
 * One attempt to connect a site: where to log in, what to look for there, and
 * the button that says it is done.
 *
 * The vendor console's profile editor is the only place a person can put a
 * login into a profile, and nothing mints a link into it; so the instructions
 * are what this page has instead of an embedded browser. The attempt is held
 * open by the API for a bounded time, and a page drawn after that is told so
 * rather than shown a confirm button that will refuse.
 */
export const dynamic = 'force-dynamic';

export default async function ConnectAttemptPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;
  const client = connectClientForCookie((await headers()).get('cookie') ?? '');

  let attempt: ConnectAttempt | undefined;
  let error: string | undefined;
  try {
    attempt = await client.readAttempt(id);
  } catch (failure) {
    error = describeRefusal(failure);
  }

  if (attempt === undefined) {
    return (
      <section>
        <h1>Connect a site</h1>
        <p role="alert">This attempt could not be read: {error}.</p>
        <p>
          <Link href="/connect">Back to your sites</Link>
        </p>
      </section>
    );
  }

  if (attempt.status !== 'started') {
    return (
      <section>
        <h1>Connect {attempt.siteDomain}</h1>
        <p role="alert">This attempt is {attempt.status}; nothing more can happen to it.</p>
        <p>
          <Link href="/connect">Back to your sites</Link>
        </p>
      </section>
    );
  }

  const attemptPath = `/connect/${encodeURIComponent(attempt.id)}`;

  return (
    <section>
      <h1>Connect {attempt.siteDomain}</h1>
      <p>
        A browser profile named <code>{attempt.profileName}</code> has been made for you. Sign in
        to {attempt.siteDomain} inside it, then come back and confirm. Nothing here will ask for
        your password.
      </p>
      <ol>
        <li>
          Open{' '}
          <a href={attempt.editorUrl} target="_blank" rel="noreferrer noopener">
            the browser console&apos;s profile list
          </a>
          , find <code>{attempt.profileName}</code>, and press <strong>Open editor</strong>.
        </li>
        <li>
          In the editor&apos;s browser, go to {attempt.siteDomain} and sign in as you normally
          would. When you are signed in, close the editor: the console saves the session into the
          profile on the way out.
        </li>
        <li>Come back to this page and press the button below.</li>
      </ol>
      <p>
        This attempt stays open until {attempt.expiresAt}. After that the profile is deleted and
        you start again.
      </p>
      <form method="post" action={`${attemptPath}/confirm`}>
        <button type="submit">I am signed in: connect {attempt.siteDomain}</button>
      </form>
      <form method="post" action={`${attemptPath}/cancel`}>
        <button type="submit">Cancel and delete the profile</button>
      </form>
    </section>
  );
}
