import { z } from 'zod';

import { isDomainError } from '../../errors';
import { createLogger } from '../../logger';

const logger = createLogger('api');

const resourceIdSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid resource ID');

const blueprintParamsSchema = z.object({ blueprintId: resourceIdSchema });
const deliberationParamsSchema = z.object({ deliberationId: resourceIdSchema });
const researchParamsSchema = z.object({ researchId: resourceIdSchema });
const sessionParamsSchema = z.object({ sessionId: resourceIdSchema });

type ApiErrorCode =
  | 'conflict'
  | 'internal_error'
  | 'not_found'
  | 'service_unavailable'
  | 'validation_error';

type ApiErrorBody = {
  error: {
    code: ApiErrorCode | string;
    message: string;
  };
};

function apiError(code: ApiErrorCode | string, message: string): ApiErrorBody {
  return { error: { code, message } };
}

function errorStatus(error: unknown): 404 | 409 | 500 | 503 {
  return isDomainError(error) ? error.status : 500;
}

/**
 * Routes catch their own errors, so nothing here reaches Elysia's `onError`.
 * That makes this the only place an unexpected failure can still be recorded:
 * the caller gets a deliberately vague message, and without this log the cause
 * would be discarded entirely.
 */
function errorBody(error: unknown): ApiErrorBody {
  if (isDomainError(error)) {
    // Expected control flow (404/409/503), not a defect.
    logger.debug({ code: error.code, message: error.message }, 'Request rejected by a domain rule.');
    return apiError(error.code, error.message);
  }
  logger.error({ err: error }, 'Unhandled error while serving a request.');
  return apiError('internal_error', 'An unexpected internal error occurred.');
}

export {
  apiError,
  blueprintParamsSchema,
  deliberationParamsSchema,
  errorBody,
  errorStatus,
  resourceIdSchema,
  researchParamsSchema,
  sessionParamsSchema,
};

export type {
  ApiErrorBody,
  ApiErrorCode,
};
