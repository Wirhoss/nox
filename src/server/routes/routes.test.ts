import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { createServer } from '../server';

import { webToolsConfigView } from './config';

import { routes } from './index';

const serverOptions = {
  host: '127.0.0.1',
  port: 3999,
  uiDir: '/path/that/does/not/exist',
};

describe('HTTP API contract', () => {
  test('never exposes configured web service API keys', () => {
    const view = webToolsConfigView({
      web_extract: {
        service: 'crawl4ai',
        serviceConfig: { url: 'https://crawl.example.com', apiKey: 'secret' },
        contract: {
          maxUrls: { maximum: 2 },
          maxCharactersPerPage: { default: 1000, maximum: 2000 },
        },
      },
    });

    expect(view.web_extract).toEqual({
      service: 'crawl4ai',
      serviceConfig: { url: 'https://crawl.example.com' },
      contract: {
        maxUrls: { maximum: 2 },
        maxCharactersPerPage: { default: 1000, maximum: 2000 },
      },
      hasApiKey: true,
    });
    expect(JSON.stringify(view)).not.toContain('secret');
  });

  test('registers blueprints and global sessions without the ambiguous agents route', () => {
    const registered = routes.routes.map((route) => `${route.method} ${route.path}`);

    expect(registered).toContain('GET /api/v1/blueprints');
    expect(registered).toContain('GET /api/v1/blueprints/:blueprintId');
    expect(registered).toContain('GET /api/v1/sessions');
    expect(registered).toContain('GET /api/v1/sessions/:sessionId');
    expect(registered).toContain('GET /api/v1/runs');
    expect(registered).toContain('GET /api/v1/logs');
    expect(registered).toContain('GET /api/v1/deep-research');
    expect(registered).toContain('GET /api/v1/deep-research/:researchId');
    expect(registered).toContain('POST /api/v1/deep-research');
    expect(registered).toContain('GET /api/v1/deliberations');
    expect(registered).toContain('GET /api/v1/deliberations/:deliberationId');
    expect(registered).toContain('POST /api/v1/deliberations');
    expect(registered).toContain('GET /api/v1/config/tools/web_tools');
    expect(registered).toContain('PUT /api/v1/config/tools/web_tools');
    expect(registered.some((route) => route.includes('/api/v1/agents'))).toBe(false);
  });

  test('health liveness works without initialized providers', async () => {
    const app = await createServer(serverOptions);
    const response = await app.handle(new Request('http://localhost/api/health/live'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  test('does not grant cross-origin access by default', async () => {
    const app = await createServer(serverOptions);
    const response = await app.handle(new Request('http://localhost/api/health/live', {
      headers: { Origin: 'https://attacker.example' },
    }));

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });

  test('allows only the generated inline scripts required for UI hydration', async () => {
    const uiDir = await mkdtemp(join(tmpdir(), 'nox-ui-csp-'));
    const inlineScript = 'window.__hydrated = true;';
    await writeFile(join(uiDir, 'index.html'), `<html><body><script>${inlineScript}</script></body></html>`);

    try {
      const app = await createServer({ ...serverOptions, uiDir });
      const response = await app.handle(new Request('http://localhost/'));
      const policy = response.headers.get('content-security-policy') ?? '';
      const digest = createHash('sha256').update(inlineScript).digest('base64');

      expect(response.status).toBe(200);
      expect(policy).toContain(`script-src 'self' 'sha256-${digest}'`);
      expect(policy).toContain('script-src-attr \'none\'');
      expect(policy).not.toMatch(/(?:^|;)script-src\s[^;]*'unsafe-inline'/);
    } finally {
      await rm(uiDir, { recursive: true, force: true });
    }
  });

  test('normalizes validation errors', async () => {
    const app = await createServer(serverOptions);
    const response = await app.handle(new Request('http://localhost/api/v1/sessions/not!valid'));
    const body = await response.json() as { error: { code: string } };

    expect(response.status).toBe(422);
    expect(body.error.code).toBe('validation_error');
  });
});
