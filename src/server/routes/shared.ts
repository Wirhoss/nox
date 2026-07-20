import { z } from 'zod';

import { NotFoundError } from '../../errors';

// Session ids (nanoid), permission request ids (nanoid) and agent blueprint
// ids all draw from this alphabet; malformed ids get a 422 up front instead
// of falling through to a 404 lookup.
const resourceIdSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid resource ID');

const idParamsSchema = z.object({ id: resourceIdSchema });

const agentParamsSchema = z.object({ agentId: resourceIdSchema });

const sessionParamsSchema = z.object({
  agentId: resourceIdSchema,
  sessionId: resourceIdSchema,
});

function errorStatus(error: unknown): 404 | 500 {
  return error instanceof NotFoundError ? 404 : 500;
}

export {
  agentParamsSchema,
  errorStatus,
  idParamsSchema,
  resourceIdSchema,
  sessionParamsSchema,
};
