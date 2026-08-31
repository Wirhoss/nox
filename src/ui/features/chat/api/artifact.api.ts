import { requestJson, requestStream } from '@/shared/api/http'

import { artifactRefSchema } from './chat.schemas'

import type { ArtifactRef } from './chat.schemas'

function authorization(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}` }
}

async function uploadArtifact(file: File, accessToken: string): Promise<ArtifactRef> {
  return requestJson('/artifacts', artifactRefSchema, {
    body: file,
    headers: {
      ...authorization(accessToken),
      'content-type': file.type.length === 0 ? 'application/octet-stream' : file.type,
      'x-artifact-filename': encodeURIComponent(file.name),
    },
    method: 'POST',
  })
}

async function readArtifact(
  artifactId: string,
  accessToken: string,
  conversationId?: string,
): Promise<Blob> {
  const query =
    conversationId === undefined
      ? ''
      : `?conversationId=${encodeURIComponent(conversationId)}`
  const response = await requestStream(
    `/artifacts/${encodeURIComponent(artifactId)}/content${query}`,
    {
      headers: authorization(accessToken),
    },
  )
  return response.blob()
}

export { readArtifact, uploadArtifact }
