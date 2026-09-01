import { createApp } from './app.js';

export interface RunningServer {
  /** Where the server actually bound - the address the process prints. */
  readonly url: string;
  stop(): Promise<void>;
}

/**
 * The API process. `createApp` builds the application and every other test
 * exercises it through Fastify's `inject`; this is the one step that puts it on
 * a socket, so a deployment needs no knowledge beyond the configuration it
 * already sets.
 */
export async function startServer(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<RunningServer> {
  const app = createApp(environment);
  const url = await app.listen({ host: app.config.host, port: app.config.port });
  return { url, stop: () => app.close() };
}
