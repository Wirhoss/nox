import { describe, expect, test } from 'bun:test';

import { closeDatabase, openDatabase } from './database';
import { DeepResearchStore } from './deepResearchStore';
import { DeliberationStore } from './deliberationStore';

describe('collaboration domain stores', () => {
  test('persist Deep Research and Deliberation independently', () => {
    const database = openDatabase(':memory:');
    const research = new DeepResearchStore(database);
    const deliberations = new DeliberationStore(database);

    try {
      research.insert({
        researchId: 'rag-options',
        title: 'Local RAG options',
        objective: 'Compare local retrieval approaches.',
      });
      deliberations.insert({
        deliberationId: 'memory-decision',
        title: 'Memory architecture',
        question: 'Which memory architecture should we adopt?',
      });

      expect(research.list('retrieval')).toHaveLength(1);
      expect(deliberations.list('architecture')).toHaveLength(1);
      expect(research.get('rag-options')?.status).toBe('draft');
      expect(deliberations.get('memory-decision')?.status).toBe('draft');

      deliberations.updateConfiguration('memory-decision', {
        moderatorBlueprintId: 'moderator',
        participantBlueprintIds: ['architect', 'critic'],
        rounds: 2,
      });
      deliberations.begin('memory-decision');
      deliberations.appendTurn({
        blueprintId: 'architect',
        content: 'Use a tiered memory model.',
        deliberationId: 'memory-decision',
        phase: 'proposal',
        round: 1,
        sessionId: 'session-1',
      });
      deliberations.setCurrentRound('memory-decision', 1);
      deliberations.complete('memory-decision', 'Adopt a tiered memory model.', true, 'consensus');

      expect(deliberations.getDetail('memory-decision')).toMatchObject({
        currentRound: 1,
        consensusReached: true,
        finalReport: 'Adopt a tiered memory model.',
        moderatorBlueprintId: 'moderator',
        participantBlueprintIds: ['architect', 'critic'],
        status: 'completed',
        terminationReason: 'consensus',
        turns: [{ blueprintId: 'architect', phase: 'proposal' }],
      });
    } finally {
      closeDatabase(database);
    }
  });
});
