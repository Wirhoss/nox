import { existsSync } from 'node:fs';

import { openapi } from '@elysia/openapi';
import { staticPlugin } from '@elysiajs/static';
import { Elysia } from 'elysia';
import { helmet } from 'elysia-helmet';

import { isDomainError } from '../errors';
import { createLogger } from '../logger';

import { routes } from './routes';
import { apiError } from './routes/shared';

const logger = createLogger('server');

type ServerOptions = {
  host: string;
  port: number;
  uiDir: string;
};

type NoxServer = Awaited<ReturnType<typeof createServer>>;

async function createServer(options: ServerOptions) {
  const app = new Elysia()
    .use(helmet())
    .use(openapi())
    .onError(({ code, error, path, set }) => {
      if (code === 'NOT_FOUND') {
        set.status = 404;
        return apiError('not_found', 'API route not found.');
      }
      if (code === 'VALIDATION') {
        set.status = 422;
        return apiError('validation_error', error.message);
      }
      if (isDomainError(error)) {
        set.status = error.status;
        return apiError(error.code, error.message);
      }
      logger.error({ err: error, code, path }, 'Request failed.');
      set.status = 500;
      return apiError('internal_error', 'An unexpected internal error occurred.');
    })
    .use(routes);

  if (existsSync(options.uiDir)) {
    app.use(await staticPlugin({
      assets: options.uiDir,
      prefix: '/',
      indexHTML: true,
    }));
  } else {
    logger.warn({ uiDir: options.uiDir }, 'UI directory not found, static UI will not be served.');
  }

  return app;
}

async function startServer(options: ServerOptions): Promise<NoxServer> {
  const app = await createServer(options);
  app.listen({ hostname: options.host, port: options.port });
  logger.info({ host: options.host, port: options.port }, 'Server listening.');
  return app;
}

export {
  createServer,
  startServer,
};

export type {
  NoxServer,
  ServerOptions,
};
