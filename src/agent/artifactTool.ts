import { z } from 'zod';

import { artifactIdSchema } from '../artifact/types';
import { ARTIFACT_ATTACH_AUTHORITY, ARTIFACT_READ_AUTHORITY } from '../auth/coreAuthorities';

import type { Tool } from '@nox/extension-api';

const ATTACH_ARTIFACT_TOOL_NAME = 'attach_artifact';
const READ_ARTIFACT_TOOL_NAME = 'read_artifact';
const DEFAULT_READ_CHARACTERS = 12_000;
const MAX_READ_CHARACTERS = 32_000;

const attachArtifactParameters = z.object({
  artifactId: artifactIdSchema.describe(
    'Artifact ID from an earlier provider or tool result in this conversation.',
  ),
});

const readArtifactParameters = z.object({
  artifactId: artifactIdSchema.describe(
    'Artifact ID already referenced by this conversation, including a user attachment.',
  ),
  maxCharacters: z
    .number()
    .int()
    .min(1)
    .max(MAX_READ_CHARACTERS)
    .default(DEFAULT_READ_CHARACTERS)
    .describe('Maximum Unicode characters to return in this page.'),
  offset: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe('Unicode character offset returned by an earlier read_artifact page.'),
});

/**
 * Selection, not creation: producers return references through their normal tool
 * response, and the model calls this only for files it wants attached to its
 * user-facing answer.
 */
function attachArtifactTool(): Tool<typeof attachArtifactParameters> {
  return {
    authority: ARTIFACT_ATTACH_AUTHORITY,
    description:
      'Attach an artifact from an earlier provider or tool result to your next user-facing ' +
      'response. Call this once for each file only after deciding the user should receive it.',
    name: ATTACH_ARTIFACT_TOOL_NAME,
    parameters: attachArtifactParameters,
    prepare: ({ artifactId }) => ({
      preview: `Attach artifact ${artifactId}`,
      risk: {
        effects: [],
        resources: [{ kind: 'file', value: artifactId }],
        reversible: true,
        volume: 1,
      },
      run: async ({ responseAttachments }) => {
        if (responseAttachments === undefined) {
          throw new Error('Artifact response attachment is not available in this session.');
        }
        const part = await responseAttachments.addArtifact(artifactId);
        const name = part.artifact.filename ?? part.artifact.artifactId;
        return [
          {
            text: `Artifact ${JSON.stringify(name)} will be attached to the next assistant response.`,
            type: 'text',
          },
        ];
      },
      title: `Attach artifact — ${artifactId}`,
      type: 'immediate',
    }),
    trust: 'trusted',
  };
}

/** Reads bounded text or returns a binary reference that a visual provider may inspect. */
function readArtifactTool(): Tool<typeof readArtifactParameters> {
  return {
    authority: ARTIFACT_READ_AUTHORITY,
    description:
      'Inspect an artifact already known to this conversation. Textual files are returned in ' +
      'bounded pages; binary files return their canonical reference for compatible model input.',
    name: READ_ARTIFACT_TOOL_NAME,
    parameters: readArtifactParameters,
    prepare: ({ artifactId, maxCharacters, offset }) => ({
      preview: `Read artifact ${artifactId} from character ${String(offset)}`,
      risk: {
        effects: ['read'],
        resources: [{ kind: 'file', value: artifactId }],
        reversible: true,
        volume: maxCharacters,
      },
      run: async ({ artifactReader }) => {
        if (artifactReader === undefined) {
          throw new Error('Artifact content reading is not available in this session.');
        }
        const result = await artifactReader.read({ artifactId, maxCharacters, offset });
        if (result === undefined) {
          throw new Error(`Artifact ${artifactId} is not available to this conversation.`);
        }

        const name = result.artifact.filename ?? result.artifact.artifactId;
        if (result.type === 'binary') {
          return [
            {
              text:
                `Artifact ${JSON.stringify(name)} is binary ${result.artifact.mediaType} ` +
                `(${String(result.artifact.size)} bytes). Its reference follows for any compatible ` +
                'model input; no textual representation is available yet.',
              type: 'text',
            },
            { artifact: result.artifact, type: 'artifact' },
          ];
        }

        const returnedCharacters = Array.from(result.text).length;
        const end = result.offset + returnedCharacters;
        const continuation =
          result.nextOffset === undefined
            ? 'End of artifact.'
            : `More content is available. Call read_artifact again with offset ${String(result.nextOffset)}.`;
        return [
          {
            text:
              `Artifact ${JSON.stringify(name)} (${result.mediaType}), characters ` +
              `${String(result.offset)}-${String(end)}:\n\n${result.text}\n\n${continuation}`,
            type: 'text',
          },
        ];
      },
      title: `Read artifact — ${artifactId}`,
      type: 'immediate',
    }),
  };
}

export {
  ATTACH_ARTIFACT_TOOL_NAME,
  attachArtifactTool,
  DEFAULT_READ_CHARACTERS,
  MAX_READ_CHARACTERS,
  READ_ARTIFACT_TOOL_NAME,
  readArtifactTool,
};
