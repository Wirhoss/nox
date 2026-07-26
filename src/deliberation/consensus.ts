import { z } from 'zod';

import { createLogger } from '../logger';

const logger = createLogger('deliberation');

const consensusAssessmentSchema = z.object({
  blockingObjections: z.array(z.string()),
  consensusReached: z.boolean(),
  reason: z.string(),
  recommendation: z.string(),
});

type ConsensusAssessment = z.infer<typeof consensusAssessmentSchema>;

function unverified(reason: string): ConsensusAssessment {
  return {
    blockingObjections: [reason],
    consensusReached: false,
    reason: 'Consensus could not be verified, so deliberation continues.',
    recommendation: '',
  };
}

/**
 * Reads the moderator's checkpoint output. Anything unparseable fails closed and
 * consumes another round, and consensus never survives a blocking objection.
 */
function parseConsensusAssessment(output: string): ConsensusAssessment {
  const firstBrace = output.indexOf('{');
  const lastBrace = output.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    logger.warn(
      { outputPreview: output.slice(0, 200) },
      'Moderator returned no structured consensus assessment; treating it as unverified.',
    );
    return unverified('The moderator did not return a structured consensus assessment.');
  }
  let issues: unknown;
  try {
    const parsed = consensusAssessmentSchema.safeParse(JSON.parse(output.slice(firstBrace, lastBrace + 1)));
    if (parsed.success) {
      return {
        ...parsed.data,
        consensusReached: parsed.data.consensusReached && parsed.data.blockingObjections.length === 0,
      };
    }
    issues = parsed.error.issues;
  } catch (error) {
    // A malformed checkpoint must fail closed and consume another round.
    issues = error;
  }
  logger.warn(
    { issues, outputPreview: output.slice(0, 200) },
    'Moderator returned an invalid consensus assessment; consuming another round.',
  );
  return unverified('The moderator returned an invalid consensus assessment.');
}

function renderConsensusAssessment(assessment: ConsensusAssessment): string {
  const objections = assessment.blockingObjections.length === 0
    ? '- None'
    : assessment.blockingObjections.map((objection) => `- ${objection}`).join('\n');
  return [
    `**Consensus reached:** ${assessment.consensusReached ? 'Yes' : 'No'}`,
    `**Recommendation:** ${assessment.recommendation || 'No common recommendation yet.'}`,
    `**Reason:** ${assessment.reason}`,
    '',
    '**Blocking objections:**',
    objections,
  ].join('\n\n');
}

export {
  consensusAssessmentSchema,
  parseConsensusAssessment,
  renderConsensusAssessment,
};

export type {
  ConsensusAssessment,
};
