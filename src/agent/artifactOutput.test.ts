import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { artifactConversationScope } from '../artifact/output';
import { ArtifactPipeline } from '../artifact/pipeline';
import { Database } from '../database/database';
import { messages } from '../database/schema';
import { ChatProvider } from '../provider/provider';
import { testCatalog, testOrigin } from '../testFixtures';
import { Agent } from './agent';

import type { ModelConfig, TextGenerateOptions } from '../provider/config';
import type { ProviderSourceEvent } from '../provider/stream';
import type { Tool } from '../tool/tool';
import type { Message } from './context/message';

const MODEL: ModelConfig = {
  inputModalities: ['text'],
  modelId: 'artifact-model',
  outputModalities: ['text', 'document'],
};

class ArtifactProvider extends ChatProvider {
  public readonly requestedTools: Tool[][] = [];

  constructor() {
    super({ baseUrl: 'https://provider.invalid', maxRetries: 0 });
  }

  public override fetchModelIds(): Promise<string[]> {
    return Promise.resolve([]);
  }

  protected override async *attempt(
    _systemPrompt: string,
    _history: Message[],
    tools: Tool[],
    options: TextGenerateOptions | undefined,
    _signal: AbortSignal,
  ): AsyncIterable<ProviderSourceEvent> {
    this.requestedTools.push([...tools]);
    if (options?.artifactOutput === undefined) throw new Error('No artifact output sink.');
    const part = await options.artifactOutput.publish({
      data: new Blob(['provider output']),
      declaredMediaType: 'text/plain',
      filename: 'answer.txt',
    });
    yield { artifact: part.artifact, type: 'artifact' };
    yield { type: 'end' };
  }
}

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
});

describe('agent artifact output', () => {
  test('streams provider bytes into a conversation-owned assistant artifact', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nox-agent-artifact-output-'));
    const database = await Database.open({ path: join(directory, 'nox.db') });
    cleanup.push(async () => {
      await database.close();
      try {
        rmSync(directory, { force: true, recursive: true });
      } catch {
        // Windows may briefly retain a SQLite handle.
      }
    });
    const artifacts = await ArtifactPipeline.open({ dataDirectory: directory, database });
    const provider = new ArtifactProvider();
    const agent = new Agent(database, provider, MODEL, {
      agentId: 'artifact-agent',
      artifacts,
      authorities: testCatalog(),
      systemPrompt: 'produce a file',
    });
    const scope = artifactConversationScope('web', 'conversation-1');
    const session = await agent.openSession({ artifactScope: scope });
    cleanup.push(() => session.stop());

    session.send('make it', testOrigin());
    await session.idle;
    await session.flushed;

    const assistant = session.getTranscript().find((message) => message.role === 'assistant');
    const part =
      assistant?.role === 'assistant'
        ? assistant.content.find((content) => content.type === 'artifact')
        : undefined;
    if (part?.type !== 'artifact') throw new Error('Assistant artifact was not recorded.');
    const payload = await artifacts.open(part.artifact.artifactId, scope);

    const presentationTool = provider.requestedTools[0]?.find(
      (tool) => tool.name === 'present_artifact',
    );
    expect(presentationTool).toMatchObject({
      authority: 'nox.artifacts.present',
      trust: 'trusted',
    });
    expect(part.artifact).toMatchObject({
      filename: 'answer.txt',
      mediaType: 'text/plain',
      size: 15,
    });
    expect(payload.artifact.provenance).toMatchObject({
      details: { modelId: 'artifact-model', sessionId: session.sessionId },
      type: 'provider',
    });
    expect(await new Response(payload.stream).text()).toBe('provider output');
    expect(JSON.stringify(await database.db.select().from(messages))).not.toContain(
      'provider output',
    );
  });
});
