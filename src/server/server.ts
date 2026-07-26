import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { openapi } from '@elysia/openapi';
import { staticPlugin } from '@elysiajs/static';
import { Elysia } from 'elysia';
import { helmet } from 'elysia-helmet';

import { isDomainError } from '../errors';
import { createLogger } from '../logger';

import { routes } from './routes';
import { apiError } from './routes/shared';

const logger = createLogger('server');

/** Requests slower than this are worth seeing without turning on debug. */
const SLOW_REQUEST_MS = 1_000;

/**
 * The log viewer polls this route, so logging it would feed the ring buffer
 * with records about reading the ring buffer.
 */
const ACCESS_LOG_EXCLUDED_PATHS = new Set(['/api/v1/logs']);

/** Per-request start times, keyed by the request itself to avoid a derive. */
const requestStartedAt = new WeakMap<Request, number>();

async function collectInlineScriptHashes(directory: string): Promise<string[]> {
  const hashes = new Set<string>();

  async function visit(currentDirectory: string): Promise<void> {
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const path = join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        return;
      }
      if (!entry.isFile() || !entry.name.endsWith('.html')) {
        return;
      }

      const html = await readFile(path, 'utf8');
      for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
        const script = match[1];
        if (!script) continue;
        const digest = createHash('sha256').update(script).digest('base64');
        hashes.add(`'sha256-${digest}'`);
      }
    }));
  }

  await visit(directory);
  return [...hashes].sort();
}

type ServerOptions = {
  host: string;
  port: number;
  uiDir: string;
};

type NoxServer = Awaited<ReturnType<typeof createServer>>;

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function createServer(options: ServerOptions) {
  const uiExists = existsSync(options.uiDir);
  const inlineScriptHashes = uiExists
    ? await collectInlineScriptHashes(options.uiDir)
    : [];
  const app = new Elysia()
    .use(helmet({
      contentSecurityPolicy: {
        directives: {
          scriptSrc: ['\'self\'', ...inlineScriptHashes],
        },
      },
    }))
    .use(openapi())
    .onRequest(({ request }) => {
      requestStartedAt.set(request, Date.now());
    })
    .onAfterResponse({ as: 'global' }, ({ path, request, set }) => {
      if (ACCESS_LOG_EXCLUDED_PATHS.has(path)) return;
      const startedAt = requestStartedAt.get(request);
      requestStartedAt.delete(request);
      const durationMs = startedAt === undefined ? undefined : Date.now() - startedAt;
      const status = typeof set.status === 'number' ? set.status : 200;
      const record = { durationMs, method: request.method, path, status };

      // Successful, fast requests are debug-only: the UI polls often enough
      // that logging them at info would drown everything else out.
      // Distinct from onError's 'Request failed.': this line is the access
      // record, that one carries the cause.
      if (status >= 500) {
        logger.error(record, 'Request errored.');
      } else if (status >= 400) {
        logger.warn(record, 'Request rejected.');
      } else if (durationMs !== undefined && durationMs >= SLOW_REQUEST_MS) {
        logger.info(record, 'Slow request.');
      } else {
        logger.debug(record, 'Request handled.');
      }
    })
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

  if (uiExists) {
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
