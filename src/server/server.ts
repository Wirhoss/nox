import { existsSync } from 'node:fs';

import { Elysia } from 'elysia';
import { cors } from '@elysia/cors'
import { helmet } from 'elysia-helmet';
import { openapi } from '@elysia/openapi'
import { staticPlugin } from '@elysiajs/static';


import { AgentRegistry } from '../agent/registry';
import { createLogger } from '../logger';


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
    .use(cors())
    .use(openapi())
    .onError(({ code, error, path }) => {
      if (code === 'NOT_FOUND') {
        return;
      }
      logger.error({ err: error, code, path }, 'Request failed.');
    })
    .get('/api/health', () => ({ status: 'ok' }))
    .group('/api/v1', (api) => api
      .get('/sessions', () => AgentRegistry.instance.listSessions())
      // TODO: POST /sessions (create from blueprint), GET /sessions/:id,
      // POST /sessions/:id/messages, GET /sessions/:id/events (SSE stream)
    );

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
