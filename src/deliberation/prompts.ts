import type { DeliberationRecord, DeliberationTurnRecord } from '../database';

const MAX_TRANSCRIPT_CHARACTERS = 48_000;

function transcript(turns: DeliberationTurnRecord[]): string {
  const rendered = turns.map((turn) => [
    `### Round ${turn.round} · ${turn.blueprintId} · ${turn.phase}`,
    turn.content,
  ].join('\n')).join('\n\n');
  return rendered.length <= MAX_TRANSCRIPT_CHARACTERS
    ? rendered
    : `[Earlier material omitted to fit the context window.]\n\n${rendered.slice(-MAX_TRANSCRIPT_CHARACTERS)}`;
}

function proposalPrompt(deliberation: DeliberationRecord): string {
  return [
    'You are a participant in a structured deliberation.',
    'Analyze the decision independently. State your recommendation, assumptions, evidence, tradeoffs, risks, and uncertainties.',
    'Do not claim consensus and do not address other participants yet.',
    '',
    `Decision question: ${deliberation.question}`,
  ].join('\n');
}

function critiquePrompt(deliberation: DeliberationRecord, round: number, turns: DeliberationTurnRecord[]): string {
  return [
    `This is critique round ${round} of a structured deliberation.`,
    'Review the positions below. Identify the strongest competing argument, challenge weak assumptions, incorporate valid criticism, and produce a revised recommendation.',
    'Be explicit about what changed in your position. Do not invent consensus.',
    '',
    `Decision question: ${deliberation.question}`,
    '',
    transcript(turns),
  ].join('\n');
}

function consensusPrompt(deliberation: DeliberationRecord, round: number, turns: DeliberationTurnRecord[]): string {
  return [
    `Perform the consensus checkpoint after critique round ${round}.`,
    'Consensus requires the same actionable recommendation and no unresolved blocking objection. Similar wording, a simple majority, or agreement on only part of the decision is not sufficient.',
    'Return only one JSON object with exactly these fields:',
    '{"consensusReached":boolean,"recommendation":string,"blockingObjections":string[],"reason":string}',
    'Set consensusReached to true only when blockingObjections is empty.',
    '',
    `Decision question: ${deliberation.question}`,
    '',
    transcript(turns),
  ].join('\n');
}

function synthesisPrompt(deliberation: DeliberationRecord, consensusReached: boolean, turns: DeliberationTurnRecord[]): string {
  return [
    'You are the moderator of a completed structured deliberation.',
    'Synthesize the record faithfully. Do not decide by majority alone and do not hide meaningful dissent.',
    consensusReached
      ? 'The deliberation ended early because a checkpoint verified consensus without blocking objections.'
      : 'The deliberation reached its maximum rounds. Preserve every unresolved blocking objection.',
    'Return Markdown with exactly these sections: Recommendation, Rationale, Agreements, Remaining disagreements, Risks and mitigations, Confidence, Next actions.',
    'Confidence must be Low, Medium, or High with a short explanation.',
    '',
    `Decision question: ${deliberation.question}`,
    '',
    transcript(turns),
  ].join('\n');
}

export {
  consensusPrompt,
  critiquePrompt,
  MAX_TRANSCRIPT_CHARACTERS,
  proposalPrompt,
  synthesisPrompt,
  transcript,
};
