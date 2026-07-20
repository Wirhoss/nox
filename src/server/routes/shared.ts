import { z } from 'zod';

import { isDomainError } from '../../errors';

const resourceIdSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid resource ID');

const blueprintParamsSchema = z.object({ blueprintId: resourceIdSchema });
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

function errorBody(error: unknown): ApiErrorBody {
  if (isDomainError(error)) {
    return apiError(error.code, error.message);
  }
  return apiError('internal_error', 'An unexpected internal error occurred.');
}

export {
  apiError,
  blueprintParamsSchema,
  errorBody,
  errorStatus,
  resourceIdSchema,
  sessionParamsSchema,
};

export type {
  ApiErrorBody,
  ApiErrorCode,
};
