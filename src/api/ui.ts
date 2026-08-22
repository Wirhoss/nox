import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

import { Elysia } from 'elysia';

interface UiOptions {
  apiPrefix: string;
  directory: string;
}

const NOT_FOUND = (): Response => new Response('Not Found', { status: 404 });

function isWithin(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** Resolves a URL path below the build root without permitting traversal. */
function filePath(root: string, pathname: string): string | undefined {
  if (pathname.includes('\0')) return undefined;

  const candidate = resolve(root, pathname.replace(/^[/\\]+/u, ''));
  const fromRoot = relative(root, candidate);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
    return undefined;
  return candidate;
}

function cacheControl(pathname: string): string {
  if (pathname.endsWith('.html')) return 'no-cache';
  if (/(?:^|\/)[^/]+-[A-Za-z0-9_-]{8,}\.[^/]+$/u.test(pathname)) {
    return 'public, max-age=31536000, immutable';
  }
  return 'public, max-age=3600';
}

async function staticResponse(
  filePathname: string,
  cacheHeader: string,
): Promise<Response | undefined> {
  const file = Bun.file(filePathname);
  if (!(await file.exists())) return undefined;

  return new Response(file, { headers: { 'cache-control': cacheHeader } });
}

function requestPath(request: Request): string | undefined {
  try {
    return decodeURIComponent(new URL(request.url).pathname);
  } catch {
    return undefined;
  }
}

/** Serves a Vite build and falls back to index.html for client-side routes. */
function createUi(options: UiOptions) {
  const root = resolve(options.directory);
  const indexPath = resolve(root, 'index.html');

  return new Elysia({ name: 'nox.ui' }).get('/*', async ({ request }) => {
    const pathname = requestPath(request);
    if (pathname === undefined || isWithin(pathname, options.apiPrefix)) return NOT_FOUND();

    const pathnameOnDisk = filePath(root, pathname);
    if (pathnameOnDisk === undefined) return NOT_FOUND();

    const exact = await staticResponse(pathnameOnDisk, cacheControl(pathname));
    if (exact !== undefined) return exact;

    // A missing file is a real 404, not a valid client-side navigation.
    if (extname(pathname) !== '') return NOT_FOUND();

    return (await staticResponse(indexPath, 'no-cache')) ?? NOT_FOUND();
  });
}

function ui(options: UiOptions): ReturnType<typeof createUi> {
  return createUi(options);
}

export { ui };

export type { UiOptions };
