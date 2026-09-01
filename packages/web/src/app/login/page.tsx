/**
 * The only page a signed-out visitor can reach, and the only one that can end
 * that state.
 *
 * There is no password field and no "create an account" link, because there is
 * no account creation: a link is issued only for an address that already names
 * a row. That is what lets the confirmation below be the same sentence whoever
 * typed whatever - it is not a polite evasion, it is the whole truth about what
 * this form does.
 */
export const dynamic = 'force-dynamic';

/** What `GET /auth/callback` appends when it refuses a link. */
const INVALID_LINK = 'invalid_link';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function LoginPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parameters = await searchParams;
  const sent = first(parameters['sent']) === '1';
  const invalid = first(parameters['error']) === INVALID_LINK;

  return (
    <section>
      <h1>Sign in</h1>
      {invalid ? (
        // Deliberately one message for expired, already-used, tampered-with and
        // never-issued: the visitor's next move is the same in all four cases,
        // and telling them apart would describe somebody else's link.
        <p role="alert">That link has already been used or has expired. Ask for another.</p>
      ) : null}
      {sent ? (
        <p role="status">
          If that address has an account, a sign-in link is on its way to it. The link works
          once and expires shortly.
        </p>
      ) : null}
      <form method="post" action="/login/request">
        <label htmlFor="email">Email address</label>
        <input id="email" name="email" type="email" required autoComplete="email" />
        <button type="submit">Email me a sign-in link</button>
      </form>
    </section>
  );
}
