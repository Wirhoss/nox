import { z } from 'zod';

import { artifactIdSchema } from '../artifact/types';
import { ARTIFACT_PRESENT_AUTHORITY } from '../auth/coreAuthorities';

import type { Tool } from '../tool/tool';

const PRESENT_ARTIFACT_TOOL_NAME = 'present_artifact';
const presentArtifactParameters = z.object({
  artifactId: artifactIdSchema.describe(
    'Artifact ID from an earlier provider or tool result in this conversation.',
  ),
});

/**
 * Selection, not creation: producers return references to the model through their normal tool
 * response, and the model calls this only for files it has decided the user should receive.
 */
function presentArtifactTool(): Tool<typeof presentArtifactParameters> {
  return {
    authority: ARTIFACT_PRESENT_AUTHORITY,
    description:
      'Attach an artifact from an earlier provider or tool result to your next user-facing ' +
      'response. Call this once for each artifact only after deciding the user should receive it.',
    name: PRESENT_ARTIFACT_TOOL_NAME,
    parameters: presentArtifactParameters,
    prepare: ({ artifactId }) => ({
      preview: `Present artifact ${artifactId}`,
      risk: {
        effects: [],
        resources: [{ kind: 'file', value: artifactId }],
        reversible: true,
        volume: 1,
      },
      run: async ({ responseArtifacts }) => {
        if (responseArtifacts === undefined) {
          throw new Error('Artifact response output is not available in this session.');
        }
        const part = await responseArtifacts.addArtifact(artifactId);
        const name = part.artifact.filename ?? part.artifact.artifactId;
        return [
          {
            text: `Artifact ${JSON.stringify(name)} will be attached to the next assistant response.`,
            type: 'text',
          },
        ];
      },
      title: `Present artifact — ${artifactId}`,
      type: 'immediate',
    }),
    trust: 'trusted',
  };
}

export { PRESENT_ARTIFACT_TOOL_NAME, presentArtifactTool };
