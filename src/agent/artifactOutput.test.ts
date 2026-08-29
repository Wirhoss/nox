import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type ChatModelConfig,
  ChatProvider,
  type Message,
  type ProviderSourceEvent,
  type TextGenerateOptions,
  type Tool,
} from '@nox/extension-api';
import { afterEach, describe, expect, test } from 'bun:test';

import { artifactConversationScope } from '../artifact/output';
import { ArtifactPipeline, artifactRef } from '../artifact/pipeline';
import { Database } from '../database/database';
import { messages } from '../database/schema';
import { permissiveAuthorization, testCatalog, testOrigin } from '../testFixtures';
import { Agent } from './agent';

const MODEL: ChatModelConfig = {
  kind: 'chat',
  inputModalities: ['text'],
  modelId: 'artifact-model',
  outputModalities: ['text', 'document'],
};

class ArtifactReadingProvider extends ChatProvider {
  public readResponse = '';

  readonly #artifactId: string;

  constructor(artifactId: string) {
    super({ maxRetries: 0 });
    this.#artifactId = artifactId;
  }

  public override fetchModelIds(): Promise<string[]> {
    return Promise.resolve([]);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  protected override async *attempt(
    _systemPrompt: string,
    history: Message[],
    tools: Tool[],
    _options: TextGenerateOptions | undefined,
    _signal: AbortSignal,
  ): AsyncIterable<ProviderSourceEvent> {
    if (tools.length === 0) {
      yield { text: 'artifact reading', type: 'textFragment' };
      yield { type: 'end' };
      return;
    }

    const response = history.findLast(
      (message) => message.role === 'toolResponse' && message.name === 'read_artifact',
    );
    if (response?.role !== 'toolResponse') {
      yield {
        toolCall: {
          arguments: { artifactId: this.#artifactId },
          name: 'read_artifact',
          role: 'toolCall',
          trackId: 'read-upload',
        },
        type: 'toolCall',
      };
      yield { type: 'end' };
      return;
    }

    this.readResponse = response.response
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('');
    yield { text: 'read', type: 'textFragment' };
    yield { type: 'end' };
  }
}

class ArtifactProvider extends ChatProvider {
  public readonly requestedTools: Tool[][] = [];

  constructor() {
    super({ maxRetries: 0 });
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
  test('reads an account-owned user attachment through the conversation capability', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nox-agent-artifact-read-'));
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
    const stored = await artifacts.ingest({
      data: new Blob(['one\ntwo\nthree']),
      declaredMediaType: 'text/plain',
      filename: 'notes.txt',
      provenance: { type: 'upload' },
      scope: { id: 'account-1', type: 'account' },
    });
    const provider = new ArtifactReadingProvider(stored.artifactId);
    const agent = new Agent(database, provider, MODEL, {
      agentId: 'artifact-reader',
      artifacts,
      authorities: testCatalog(),
      systemPrompt: 'read the attached file',
    });
    const session = await agent.openSession({
      artifactScope: artifactConversationScope('web', 'conversation-read'),
      authorization: permissiveAuthorization,
    });
    cleanup.push(() => session.stop());

    session.send(
      [
        { text: 'Read this.', type: 'text' },
        { artifact: artifactRef(stored), type: 'artifact' },
      ],
      testOrigin(),
    );
    await session.idle;

    expect(provider.readResponse).toContain('characters 0-13');
    expect(provider.readResponse).toContain('one\ntwo\nthree');
    expect(provider.readResponse).toContain('End of artifact.');
  });

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

    const attachmentTool = provider.requestedTools[0]?.find(
      (tool) => tool.name === 'attach_artifact',
    );
    const readerTool = provider.requestedTools[0]?.find((tool) => tool.name === 'read_artifact');
    expect(attachmentTool).toMatchObject({
      authority: 'nox.artifacts.attach',
      trust: 'trusted',
    });
    expect(readerTool).toMatchObject({ authority: 'nox.artifacts.read' });
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
