import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';

import { loadConfig, type AppConfig } from './config.js';
import { errorEnvelope, violationDetails, type ErrorCode } from './errors.js';

declare module 'fastify' {
  interface FastifyInstance {
    readonly config: AppConfig;
  }
}

/**
 * Fastify raises these before any handler runs, so the codes are the only way
 * to tell a body it could not parse from a body it could not accept.
 */
const CODE_BY_STATUS: Readonly<Record<number, ErrorCode>> = {
  400: 'malformed_json',
  404: 'not_found',
  405: 'method_not_allowed',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
};

export function createApp(environment: NodeJS.ProcessEnv = process.env): FastifyInstance {
  const config = loadConfig(environment);
  const app = Fastify({
    logger: { level: config.logLevel },
    // Report every schema violation in one response; a client fixing a form
    // should not have to submit it once per bad field.
    ajv: { customOptions: { allErrors: true, coerceTypes: false, removeAdditional: false } },
  });

  app.decorate('config', config);

  app.get('/health', () => ({ status: 'ok' }));

  app.setNotFoundHandler((request, reply) => {
    void reply
      .status(404)
      .send(
        errorEnvelope('not_found', `Route ${request.method} ${request.url} does not exist.`),
      );
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.validation !== undefined) {
      void reply
        .status(400)
        .send(
          errorEnvelope(
            'validation_failed',
            'The request did not match the schema for this route.',
            violationDetails(error.validation),
          ),
        );
      return;
    }
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      // The reason stays in the log, where operators can see it, and out of the
      // response, where a connection string would otherwise end up.
      request.log.error({ err: error }, 'request handler failed');
      void reply
        .status(500)
        .send(errorEnvelope('internal_error', 'The server failed to handle the request.'));
      return;
    }
    void reply.status(status).send(errorEnvelope(CODE_BY_STATUS[status] ?? 'bad_request', error.message));
  });

  return app;
}
