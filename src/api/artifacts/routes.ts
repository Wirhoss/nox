import { Elysia } from 'elysia';
import { z } from 'zod';

import {
  artifactConversationScope,
  artifactIdSchema,
  type ArtifactPipeline,
  artifactRef,
  ArtifactStorageQuotaError,
  ArtifactTooLargeError,
} from '../../artifact';
import { authGuard } from '../auth/guard';
import { WEB_BROKER_ID } from '../chat/id';

import type { AuthStore } from '../auth/store';

const artifactParamsSchema = z.object({ artifactId: artifactIdSchema });
const artifactQuerySchema = z.object({
  conversationId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional(),
});
const INVALID_UPLOAD = { error: 'invalid_artifact_upload' } as const;
const ARTIFACT_NOT_FOUND = { error: 'artifact_not_found' } as const;

interface ArtifactRoutesOptions {
  readonly artifacts: ArtifactPipeline;
  readonly store: AuthStore;
}

function contentDisposition(filename: string | undefined): string {
  const safe = filename ?? 'artifact';
  return `attachment; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

function uploadedFilename(request: Request): string | undefined {
  const encoded = request.headers.get('x-artifact-filename');
  if (encoded === null || encoded.length === 0) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

function createArtifactRoutes(options: ArtifactRoutesOptions) {
  const { artifacts, store } = options;

  return new Elysia({ name: 'nox.api.artifacts.routes' })
    .use(authGuard(store))
    .post(
      '/artifacts',
      async ({ account, request, sessionId, status }) => {
        if (request.body === null) return status(400, INVALID_UPLOAD);

        try {
          const record = await artifacts.ingest({
            data: request.body,
            declaredMediaType: request.headers.get('content-type') ?? undefined,
            filename: uploadedFilename(request),
            provenance: { details: { authSessionId: sessionId }, type: 'upload' },
            scope: { id: account.accountId, type: 'account' },
            signal: request.signal,
          });
          return status(201, artifactRef(record));
        } catch (error) {
          if (error instanceof ArtifactTooLargeError) {
            return status(413, {
              detail: error.message,
              error: 'artifact_too_large',
              maxBytes: error.maxBytes,
            });
          }
          if (error instanceof ArtifactStorageQuotaError) {
            return status(507, {
              detail: error.message,
              error: 'artifact_storage_full',
              maxBytes: error.maxBytes,
            });
          }
          throw error;
        }
      },
      { authenticated: true },
    )
    .get(
      '/artifacts/:artifactId/content',
      async ({ account, params, query, status }) => {
        const accountScope = { id: account.accountId, type: 'account' as const };
        let record = await artifacts.find(params.artifactId, accountScope);
        if (record === undefined && query.conversationId !== undefined) {
          record = await artifacts.find(
            params.artifactId,
            artifactConversationScope(WEB_BROKER_ID, query.conversationId),
          );
        }
        if (record === undefined) return status(404, ARTIFACT_NOT_FOUND);

        const payload = await artifacts.open(record.artifactId, record.scope);
        return new Response(payload.stream, {
          headers: {
            'cache-control': 'private, max-age=31536000, immutable',
            'content-disposition': contentDisposition(record.filename),
            'content-length': String(record.size),
            'content-type': record.mediaType,
            etag: `"${record.blobHash}"`,
            'x-content-type-options': 'nosniff',
          },
        });
      },
      {
        authenticated: true,
        params: artifactParamsSchema,
        query: artifactQuerySchema,
      },
    );
}

function artifactRoutes(options: ArtifactRoutesOptions): ReturnType<typeof createArtifactRoutes> {
  return createArtifactRoutes(options);
}

export { artifactRoutes };

export type { ArtifactRoutesOptions };
