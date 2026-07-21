import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { AgentRegistry } from '../../agent/registry';
import { DeepResearchRegistry } from '../../deepResearch';
import { DeliberationRegistry } from '../../deliberation';
import { ProviderRegistry } from '../../provider';
import { ToolRegistry } from '../../tool/registry';

import { deepResearchRoutes } from './deepResearch';
import { deliberationRoutes } from './deliberations';

describe('collaboration domain routes', () => {
  const originalFetch = globalThis.fetch;
  let checkpointConsensus = true;
  let activeParticipantRequests = 0;
  let maximumParallelParticipants = 0;
  let critiquePrompts: string[] = [];

  beforeAll(async () => {
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).pathname.endsWith('/models')) {
        return Response.json({ data: [{ id: 'test-model' }] });
      }
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string; role: string }> };
      const systemPrompt = body.messages.find((message) => message.role === 'system')?.content ?? 'Agent';
      const latestPrompt = body.messages.findLast((message) => message.role === 'user')?.content ?? '';
      if (!systemPrompt.includes('Moderator')) {
        if (latestPrompt.startsWith('This is critique round')) critiquePrompts.push(latestPrompt);
        activeParticipantRequests += 1;
        maximumParallelParticipants = Math.max(maximumParallelParticipants, activeParticipantRequests);
        await Bun.sleep(15);
        activeParticipantRequests -= 1;
      }
      const label = latestPrompt.includes('Perform the consensus checkpoint')
        ? JSON.stringify({
          blockingObjections: checkpointConsensus ? [] : ['The operational risk remains unresolved.'],
          consensusReached: checkpointConsensus,
          reason: checkpointConsensus ? 'Both participants now support the same architecture.' : 'A blocking objection remains.',
          recommendation: 'Adopt the tiered architecture.',
        })
        : systemPrompt.includes('Moderator')
          ? 'Moderator synthesis'
          : systemPrompt.includes('Critic')
            ? 'Critic proposal'
            : 'Architect proposal';
      const stream = [
        `data: {"choices":[{"delta":{"content":${JSON.stringify(label)}}}]}`,
        'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3}}',
        'data: [DONE]',
        '',
      ].join('\n\n');
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    await ProviderRegistry.instance.init({
      test: {
        baseUrl: 'https://deliberation.test/v1',
        defaultModel: 'test-model',
        type: 'openai_completions',
      },
    });
    await ToolRegistry.instance.init({});
    await AgentRegistry.instance.init([
      {
        config: { maxIterations: 2, modelId: 'test-model', providerId: 'test' },
        coreTools: [],
        description: 'Architecture perspective',
        id: 'architect',
        lazyLoadedTools: [],
        systemPrompt: 'You are the Architect.',
      },
      {
        config: { maxIterations: 2, modelId: 'test-model', providerId: 'test' },
        coreTools: [],
        description: 'Critical perspective',
        id: 'critic',
        lazyLoadedTools: [],
        systemPrompt: 'You are the Critic.',
      },
      {
        config: { maxIterations: 2, modelId: 'test-model', providerId: 'test' },
        coreTools: [],
        description: 'Neutral moderator',
        id: 'moderator',
        lazyLoadedTools: [],
        systemPrompt: 'You are the Moderator.',
      },
    ], ':memory:');
    DeepResearchRegistry.instance.init(':memory:');
    DeliberationRegistry.instance.init(':memory:');
  });

  afterAll(async () => {
    await DeliberationRegistry.instance.close();
    DeepResearchRegistry.instance.close();
    AgentRegistry.instance.close();
    globalThis.fetch = originalFetch;
  });

  test('creates a Deep Research draft', async () => {
    const response = await deepResearchRoutes.handle(new Request('http://localhost/api/v1/deep-research', {
      body: JSON.stringify({ title: 'Local RAG', objective: 'Compare retrieval options.' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }));
    const body = await response.json() as { objective: string; status: string };

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ objective: 'Compare retrieval options.', status: 'draft' });
  });

  test('requires participants and a moderator when creating a Deliberation', async () => {
    const response = await deliberationRoutes.handle(new Request('http://localhost/api/v1/deliberations', {
      body: JSON.stringify({ title: 'Memory', question: 'Which design should we adopt?' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }));
    expect(response.status).toBe(422);
  });

  test('accepts an entered maximum of 100 rounds', async () => {
    const response = await deliberationRoutes.handle(new Request('http://localhost/api/v1/deliberations', {
      body: JSON.stringify({
        moderatorBlueprintId: 'moderator',
        participantBlueprintIds: ['architect', 'critic'],
        question: 'Which design should we adopt?',
        rounds: 100,
        title: 'Long deliberation',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }));
    const body = await response.json() as { rounds: number; status: string };

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ rounds: 100, status: 'draft' });
  });

  test('stops early when the moderator verifies consensus', async () => {
    maximumParallelParticipants = 0;
    critiquePrompts = [];
    const createdResponse = await deliberationRoutes.handle(new Request('http://localhost/api/v1/deliberations', {
      body: JSON.stringify({
        moderatorBlueprintId: 'moderator',
        participantBlueprintIds: ['architect', 'critic'],
        question: 'Which design should we adopt?',
        rounds: 3,
        title: 'Architecture decision',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }));
    const created = await createdResponse.json() as { deliberationId: string };

    const startResponse = await deliberationRoutes.handle(new Request(
      `http://localhost/api/v1/deliberations/${created.deliberationId}/run`,
      { method: 'POST' },
    ));
    expect(startResponse.status).toBe(202);

    let detail: {
      consensusReached: boolean;
      currentRound: number;
      finalReport: string | null;
      status: string;
      terminationReason: string | null;
      turns: Array<{ phase: string }>;
    } | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const response = await deliberationRoutes.handle(new Request(
        `http://localhost/api/v1/deliberations/${created.deliberationId}`,
      ));
      detail = await response.json() as typeof detail;
      if (detail?.status !== 'active') break;
      await Bun.sleep(10);
    }

    expect(detail).toMatchObject({
      finalReport: 'Moderator synthesis',
      consensusReached: true,
      currentRound: 2,
      status: 'completed',
      terminationReason: 'consensus',
      turns: [
        { phase: 'proposal' },
        { phase: 'proposal' },
        { phase: 'critique' },
        { phase: 'critique' },
        { phase: 'consensus' },
        { phase: 'synthesis' },
      ],
    });
    expect(maximumParallelParticipants).toBe(2);
    expect(critiquePrompts).toHaveLength(2);
    expect(critiquePrompts[0]).toBe(critiquePrompts[1]);
  });

  test('uses the maximum rounds when a blocking objection remains', async () => {
    checkpointConsensus = false;
    try {
      const createdResponse = await deliberationRoutes.handle(new Request('http://localhost/api/v1/deliberations', {
        body: JSON.stringify({
          moderatorBlueprintId: 'moderator',
          participantBlueprintIds: ['architect', 'critic'],
          question: 'Should we accept the operational risk?',
          rounds: 2,
          title: 'Risk decision',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }));
      const created = await createdResponse.json() as { deliberationId: string };
      await deliberationRoutes.handle(new Request(
        `http://localhost/api/v1/deliberations/${created.deliberationId}/run`,
        { method: 'POST' },
      ));

      let detail: { consensusReached: boolean; currentRound: number; status: string; terminationReason: string | null } | undefined;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const response = await deliberationRoutes.handle(new Request(
          `http://localhost/api/v1/deliberations/${created.deliberationId}`,
        ));
        detail = await response.json() as typeof detail;
        if (detail?.status !== 'active') break;
        await Bun.sleep(10);
      }

      expect(detail).toMatchObject({
        consensusReached: false,
        currentRound: 2,
        status: 'completed',
        terminationReason: 'max_rounds',
      });
    } finally {
      checkpointConsensus = true;
    }
  });
});
