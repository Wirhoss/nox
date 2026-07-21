import { AgentRegistry } from '../agent/registry';
import { StopReason } from '../agent/runner';
import { createLogger } from '../logger';

import { parseConsensusAssessment, renderConsensusAssessment } from './consensus';
import { consensusPrompt, critiquePrompt, proposalPrompt, synthesisPrompt } from './prompts';

import type { AgentSession } from '../agent/session';
import type { DeliberationRecord, DeliberationStore, DeliberationTurnPhase } from '../database';
import type { Message } from '../provider';

const logger = createLogger('deliberation');

/** The cancellation half of a running job. The registry owns the rest. */
type DeliberationJob = {
  cancelled: boolean;
  sessions: Set<AgentSession>;
};

type SessionHandle = {
  blueprintId: string;
  session: AgentSession;
  sessionId: string;
};

function assistantText(messages: readonly Message[], from: number): string {
  return messages.slice(from)
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.content)
    .filter((content) => content.type === 'text')
    .map((content) => content.text)
    .join('\n')
    .trim();
}

class DeliberationRunner {
  public constructor(
    private readonly store: DeliberationStore,
    private readonly deliberation: DeliberationRecord,
    private readonly job: DeliberationJob,
  ) {}

  public async run(): Promise<void> {
    const { moderator, participants } = this.openSessions();
    let consensusReached = false;
    let completedRounds = 0;

    for (let round = 1; round <= this.deliberation.rounds; round += 1) {
      await this.runParticipantRound(round, participants);
      completedRounds = round;
      if (round === 1) continue;

      consensusReached = await this.runConsensusCheckpoint(round, moderator);
      if (consensusReached) break;
    }

    await this.runSynthesis(moderator, consensusReached, completedRounds);
  }

  private openSessions(): { moderator: SessionHandle; participants: SessionHandle[] } {
    const participants = this.deliberation.participantBlueprintIds.map((blueprintId) =>
      this.openSession(blueprintId));
    const moderatorBlueprintId = this.deliberation.moderatorBlueprintId;
    if (!moderatorBlueprintId) throw new Error('A moderator blueprint is required.');
    return { moderator: this.openSession(moderatorBlueprintId), participants };
  }

  private openSession(blueprintId: string): SessionHandle {
    const { session, sessionId } = AgentRegistry.instance.createSession(blueprintId);
    this.job.sessions.add(session);
    return { blueprintId, session, sessionId };
  }

  private async runParticipantRound(round: number, participants: SessionHandle[]): Promise<void> {
    this.assertNotCancelled();
    const phase = round === 1 ? 'proposal' : 'critique';
    const prompt = round === 1
      ? proposalPrompt(this.deliberation)
      : critiquePrompt(this.deliberation, round, this.listTurns());

    let outputs: Array<{ handle: SessionHandle; content: string }>;
    try {
      outputs = await Promise.all(participants.map(async (handle) => ({
        content: await this.runAgent(handle.session, prompt),
        handle,
      })));
    } catch (error) {
      // One participant failing leaves the others mid-run; stop them before unwinding.
      await Promise.all(participants.map(({ session }) => session.abort()));
      throw error;
    }

    this.assertNotCancelled();
    for (const output of outputs) {
      this.appendTurn(output.handle, phase, round, output.content);
    }
    this.store.setCurrentRound(this.deliberation.deliberationId, round);
  }

  /** Returns whether the moderator verified consensus, ending the deliberation early. */
  private async runConsensusCheckpoint(round: number, moderator: SessionHandle): Promise<boolean> {
    this.assertNotCancelled();
    const output = await this.runAgent(
      moderator.session,
      consensusPrompt(this.deliberation, round, this.listTurns()),
    );
    const assessment = parseConsensusAssessment(output);
    this.appendTurn(moderator, 'consensus', round, renderConsensusAssessment(assessment));
    return assessment.consensusReached;
  }

  private async runSynthesis(moderator: SessionHandle, consensusReached: boolean, completedRounds: number): Promise<void> {
    this.assertNotCancelled();
    const finalReport = await this.runAgent(
      moderator.session,
      synthesisPrompt(this.deliberation, consensusReached, this.listTurns()),
    );
    this.appendTurn(moderator, 'synthesis', completedRounds + 1, finalReport);
    this.store.complete(
      this.deliberation.deliberationId,
      finalReport,
      consensusReached,
      consensusReached ? 'consensus' : 'max_rounds',
    );
    logger.info({ consensusReached, deliberationId: this.deliberation.deliberationId }, 'Deliberation completed.');
  }

  private async runAgent(session: AgentSession, prompt: string): Promise<string> {
    const historyLength = session.history.length;
    const reason = await session.run(prompt);
    if (reason === StopReason.Aborted || this.job.cancelled) throw new Error('Deliberation cancelled.');
    const output = assistantText(session.history, historyLength);
    if (!output) throw new Error('An agent completed without producing an answer.');
    return output;
  }

  private appendTurn(handle: SessionHandle, phase: DeliberationTurnPhase, round: number, content: string): void {
    this.store.appendTurn({
      blueprintId: handle.blueprintId,
      content,
      deliberationId: this.deliberation.deliberationId,
      phase,
      round,
      sessionId: handle.sessionId,
    });
  }

  private listTurns(): ReturnType<DeliberationStore['listTurns']> {
    return this.store.listTurns(this.deliberation.deliberationId);
  }

  private assertNotCancelled(): void {
    if (this.job.cancelled) throw new Error('Deliberation cancelled.');
  }
}

export {
  DeliberationRunner,
};

export type {
  DeliberationJob,
};
