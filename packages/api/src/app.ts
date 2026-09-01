import { createDatabase, type Database } from '@chief-of-staff/db';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';

import { loadConfig, type AppConfig } from './config.js';
import { declaredErrorCode, errorEnvelope, violationDetails, type ErrorCode } from './errors.js';
import { AJV_FORMATS } from './formats.js';
import { registerRoutes } from './routes/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    readonly config: AppConfig;
    readonly db: Database['db'];
  }
  interface FastifyRequest {
    userId: string;
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
  const database = createDatabase(config.databaseUrl);
  const app = Fastify({
    logger: { level: config.logLevel },
    // Report every schema violation in one response; a client fixing a form
    // should not have to submit it once per bad field.
    ajv: {
      customOptions: {
        allErrors: true,
        coerceTypes: false,
        removeAdditional: false,
        formats: AJV_FORMATS,
      },
    },
  });

  app.decorate('config', config);
  app.decorate('db', database.db);
  // The identity a route works on behalf of, filled in per request by
  // `resolveCaller`. Declared here because Fastify 5 will not accept a property
  // that was not declared on the request prototype.
  app.decorateRequest('userId', '');
  // The pool outlives every request but not the server, so closing the app
  // releases the connections rather than leaving a test process hanging.
  app.addHook('onClose', () => database.close());

  app.get('/health', () => ({ status: 'ok' }));
  registerRoutes(app);

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
    // A refusal a handler raised names its own code; anything Fastify raised is
    // identified by the status it chose.
    const code = declaredErrorCode(error.code) ?? CODE_BY_STATUS[status] ?? 'bad_request';
    void reply.status(status).send(errorEnvelope(code, error.message));
  });

  return app;
}
