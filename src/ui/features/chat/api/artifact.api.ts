import { requestJson, requestStream } from '@/shared/api/http'

import { type ArtifactRef, artifactRefSchema } from './chat.schemas'

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

async function readArtifact(artifactId: string, accessToken: string): Promise<Blob> {
  const response = await requestStream(`/artifacts/${encodeURIComponent(artifactId)}/content`, {
    headers: authorization(accessToken),
  })
  return response.blob()
}

export { readArtifact, uploadArtifact }
