import { createApiClient, ApiUnreachableError } from '../api-client';
import { loadWebConfig } from '../config';

/**
 * Rendered per request rather than prerendered. What this page reports - where
 * the API is and whether it is answering - is a fact about the running
 * deployment, and a value baked in at build time would be a report about the
 * machine that built the image.
 */
export const dynamic = 'force-dynamic';

async function describeApi(baseUrl: string): Promise<string> {
  const client = createApiClient({ baseUrl });
  try {
    const health = await client.health();
    return `reachable, reporting ${health.status}`;
  } catch (error: unknown) {
    // A page that renders a blank screen when the API is down tells the reader
    // nothing about which of the two is broken, so the failure is the content.
    return error instanceof ApiUnreachableError
      ? 'not answering'
      : `answering with an error (${error instanceof Error ? error.message : 'unknown'})`;
  }
}

export default async function OverviewPage() {
  const config = loadWebConfig();
  const api = await describeApi(config.apiBaseUrl);

  return (
    <section>
      <h1>Overview</h1>
      <p>
        The dashboard shell. Watches, the calendar and the task history land in the sections
        above as the rest of this sprint is built.
      </p>
      <dl>
        <dt>API</dt>
        <dd>{config.apiBaseUrl}</dd>
        <dt>Status</dt>
        <dd>{api}</dd>
      </dl>
    </section>
  );
}
