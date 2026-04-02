import type { FastifyInstance, FastifyError } from 'fastify';
import { ZodError } from 'zod';
import { isSwiftAgentError } from '@swiftagent/shared';
import type { ErrorBody } from '../types.js';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    // Zod validation errors → 400
    if (err instanceof ZodError) {
      const body: ErrorBody = {
        error: {
          code: 'VALIDATION',
          message: 'Request validation failed',
          details: err.issues,
        },
      };
      return reply.status(400).send(body);
    }

    // Domain errors from SwiftAgentError
    if (isSwiftAgentError(err)) {
      const body: ErrorBody = {
        error: {
          code: err.code,
          message: err.message,
        },
      };
      return reply.status(err.statusCode).send(body);
    }

    // Fastify validation errors (from schema validation)
    if ('validation' in err && (err as FastifyError).validation) {
      const fastifyErr = err as FastifyError;
      const body: ErrorBody = {
        error: {
          code: 'VALIDATION',
          message: fastifyErr.message,
          details: fastifyErr.validation,
        },
      };
      return reply.status(400).send(body);
    }

    // Unexpected errors — log and return generic message
    req.log.error({ err }, 'Unhandled error');
    const body: ErrorBody = {
      error: {
        code: 'INTERNAL',
        message: 'Internal server error',
      },
    };
    return reply.status(500).send(body);
  });
}
