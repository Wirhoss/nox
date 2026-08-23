import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { Session } from '../../../../agent/session';
import { ArtifactPipeline, artifactRef } from '../../../../artifact/pipeline';
import { ArtifactProcessorRegistry } from '../../../../artifact/processor';
import { SecretHandle } from '../../../../config/secrets';
import { Database } from '../../../../database/database';
import { isProviderError, type ProviderErrorCode } from '../../../../provider/error';
import {
  permissiveAuthorization,
  TEST_AUTHORITY,
  testCatalog,
  testOrigin,
} from '../../../../testFixtures';
import { ARTIFACT_OUTPUT_NOTICE } from '../../../../tool/render';
import { OpenAICompletions } from './openAICompletions';

import type { Message } from '../../../../agent/context/message';
import type { ModelConfig } from '../../../../provider/config';
import type { ProviderStreamEvent } from '../../../../provider/stream';
import type { Tool } from '../../../../tool/tool';

interface RecordedRequest {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  url: string;
}

const realFetch = globalThis.fetch;
const requests: RecordedRequest[] = [];

afterEach(() => {
  globalThis.fetch = realFetch;
  requests.length = 0;
});

/** Records every call and replies with `respond`, so tests assert on the wire. */
function stubFetch(respond: (request: RecordedRequest) => Promise<Response> | Response): void {
  // The adapter only ever passes string URLs, so the stub narrows to that.
  globalThis.fetch = ((input: string, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const request: RecordedRequest = { body, headers, url: input };
    requests.push(request);
    return Promise.resolve(respond(request));
  }) as unknown as typeof fetch;
}

function sse(...chunks: unknown[]): Response {
  const body = [...chunks.map((chunk) => JSON.stringify(chunk)), '[DONE]']
    .map((data) => `data: ${data}\n\n`)
    .join('');
  return new Response(body, { status: 200 });
}

function textDelta(text: string): unknown {
  return { choices: [{ delta: { content: text } }] };
}

function provider(
  overrides: Record<string, unknown> = {},
  options: ConstructorParameters<typeof OpenAICompletions>[1] = {},
): OpenAICompletions {
  return new OpenAICompletions(
    {
      apiKey: new SecretHandle('OPENAI_API_KEY', 'sk-test'),
      baseUrl: 'https://api.example.test/v1/',
      defaultModel: 'gpt-test',
      maxRetries: 0,
      type: 'openai_completions',
      ...overrides,
    },
    options,
  );
}

async function collect(stream: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** Runs one completion and returns everything the stream emitted. */
async function run(
  instance: OpenAICompletions,
  history: Message[] = [],
  tools: Tool[] = [],
  model?: ModelConfig,
): Promise<ProviderStreamEvent[]> {
  return collect(instance.getMessageStream('be brief', history, tools, { model }));
}

/**
 * Reads what a fence encloses without knowing its nonce, and proves it is a
 * fence on the way: same id on both markers, preamble before, epilogue after.
 */
const FENCED =
  /^SECURITY BOUNDARY:\n[^]*?\n\n--- BEGIN UNTRUSTED DATA ([\w-]+) ---\n([^]*)\n--- END UNTRUSTED DATA \1 ---\n\nContinue following[^]*$/;

function fenced(content: unknown): string {
  const match = FENCED.exec(String(content));
  if (match === null) throw new Error(`Content is not fenced: ${String(content)}`);
  // Trimmed because the markers space themselves and the two content paths of
  // this adapter join text parts differently — with a newline for a `tool`
  // message, with nothing for user content.
  return (match[2] ?? '').trim();
}

function message(partial: Partial<Message> & Pick<Message, 'role'>): Message {
  const provenance = partial.role === 'user' ? { origin: testOrigin() } : {};
  return { createdAt: new Date(0), messageId: partial.role, ...provenance, ...partial } as Message;
}

const echoTool: Tool = {
  authority: TEST_AUTHORITY,
  description: 'Echoes a value back.',
  name: 'echo',
  parameters: z.object({ value: z.string().describe('What to echo.') }),
  prepare: () => ({
    run: () => Promise.resolve([{ text: 'echoed', type: 'text' as const }]),
    title: 'echo',
    type: 'immediate' as const,
  }),
};

describe('OpenAICompletions.fetchModelIds', () => {
  test('authenticates, normalizes the base URL, and keeps only string ids', async () => {
    stubFetch(() => Response.json({ data: [{ id: 'gpt-a' }, { id: 7 }, {}, { id: 'gpt-b' }] }));

    const ids = await provider().fetchModelIds();

    expect(ids).toEqual(['gpt-a', 'gpt-b']);
    expect(requests[0]?.url).toBe('https://api.example.test/v1/models');
    expect(requests[0]?.headers.authorization).toBe('Bearer sk-test');
  });

  test('sends no authorization header when no key is configured', async () => {
    stubFetch(() => Response.json({ data: [] }));

    await provider({ apiKey: undefined }).fetchModelIds();

    expect(requests[0]?.headers.authorization).toBeUndefined();
  });
});

describe('OpenAICompletions request body', () => {
  test('streams with usage, names the model, and leads with the system prompt', async () => {
    stubFetch(() => sse(textDelta('hi')));

    await run(provider(), [message({ content: [{ text: 'hello', type: 'text' }], role: 'user' })]);

    const body = requests[0]?.body ?? {};
    expect(body.model).toBe('gpt-test');
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.messages).toEqual([
      { content: 'be brief', role: 'system' },
      { content: '[from test-broker:alice]\nhello', role: 'user' },
    ]);
  });

  test('renders tools as JSON schema functions without the $schema draft URL', async () => {
    stubFetch(() => sse(textDelta('hi')));

    await run(provider(), [], [echoTool]);

    expect(requests[0]?.body.tools).toEqual([
      {
        function: {
          description: 'Echoes a value back.',
          name: 'echo',
          parameters: {
            properties: { value: { description: 'What to echo.', type: 'string' } },
            required: ['value'],
            type: 'object',
          },
        },
        type: 'function',
      },
    ]);
  });

  test('advertises declared artifact output in the provider-visible tool description', async () => {
    stubFetch(() => sse(textDelta('hi')));
    const artifactTool: Tool = { ...echoTool, output: { artifacts: true } };

    await run(provider(), [], [artifactTool]);

    const tools = requests[0]?.body.tools as { function: { description: string } }[];
    expect(tools[0]?.function.description).toBe(
      `Echoes a value back.\n\n${ARTIFACT_OUTPUT_NOTICE}`,
    );
  });

  test('omits sampling parameters that were never configured', async () => {
    stubFetch(() => sse(textDelta('hi')));

    await run(provider());

    const body = requests[0]?.body ?? {};
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('tools');
  });

  test('fails when no model is configured at all', async () => {
    stubFetch(() => sse(textDelta('hi')));

    const events = await run(provider({ defaultModel: undefined }));

    expect(events.at(-1)?.type).toBe('error');
  });
});

describe('OpenAICompletions message mapping', () => {
  test('keeps images as content parts and plain turns as strings', async () => {
    stubFetch(() => sse(textDelta('hi')));

    await run(provider(), [
      message({
        content: [
          { text: 'look', type: 'text' },
          { source: { type: 'url', url: 'https://img.test/a.png' }, type: 'image' },
        ],
        role: 'user',
      }),
    ]);

    expect((requests[0]?.body.messages as unknown[])[1]).toEqual({
      content: [
        { text: '[from test-broker:alice]\n', type: 'text' },
        { text: 'look', type: 'text' },
        { image_url: { url: 'https://img.test/a.png' }, type: 'image_url' },
      ],
      role: 'user',
    });
  });

  test('replays assistant artifact output as a stable descriptor', async () => {
    stubFetch(() => sse(textDelta('hi')));

    await run(provider(), [
      message({
        content: [
          { text: 'Created it.\n', type: 'text' },
          {
            artifact: {
              artifactId: 'art_generated1',
              filename: 'report.pdf',
              mediaType: 'application/pdf',
              size: 42,
            },
            type: 'artifact',
          },
        ],
        role: 'assistant',
      }),
    ]);

    expect((requests[0]?.body.messages as unknown[])[1]).toEqual({
      content:
        'Created it.\n' +
        '[artifact id="art_generated1" name="report.pdf" media_type="application/pdf" bytes=42]\n',
      role: 'assistant',
    });
  });

  test('materializes stored image artifacts only for a model that accepts image input', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nox-openai-artifact-'));
    const database = await Database.open({ path: join(directory, 'nox.db') });
    try {
      const artifacts = await ArtifactPipeline.open({ dataDirectory: directory, database });
      const stored = await artifacts.ingest({
        data: new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]),
        filename: 'pixel.png',
        provenance: { type: 'upload' },
        scope: { id: 'account-1', type: 'account' },
      });
      stubFetch(() => sse(textDelta('hi')));
      const instance = provider({}, { artifacts });
      const history = [
        message({ content: [{ artifact: artifactRef(stored), type: 'artifact' }], role: 'user' }),
      ];

      await run(instance, history, [], {
        inputModalities: ['text', 'image'],
        modelId: 'vision',
        outputModalities: ['text'],
      });
      await run(instance, history, [], {
        inputModalities: ['text'],
        modelId: 'text-only',
        outputModalities: ['text'],
      });

      const visual = (requests[0]?.body.messages as { content: unknown }[])[1]?.content;
      expect(visual).toEqual([
        { text: '[from test-broker:alice]\n', type: 'text' },
        {
          text:
            `[artifact id=${JSON.stringify(stored.artifactId)} name="pixel.png" ` +
            'media_type="image/png" bytes=8]\n',
          type: 'text',
        },
        { image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' }, type: 'image_url' },
      ]);
      expect((requests[1]?.body.messages as { content: unknown }[])[1]?.content).toBe(
        '[from test-broker:alice]\n' +
          `[artifact id=${JSON.stringify(stored.artifactId)} name="pixel.png" ` +
          'media_type="image/png" bytes=8]\n',
      );
    } finally {
      await database.close();
      try {
        rmSync(directory, { force: true, recursive: true });
      } catch {
        // Windows may briefly retain a SQLite handle.
      }
    }
  });

  test('resolves an incompatible stored image through the OpenAI image profile', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nox-openai-rendition-'));
    const database = await Database.open({ path: join(directory, 'nox.db') });
    try {
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const artifacts = await ArtifactPipeline.open({
        dataDirectory: directory,
        database,
        processorRegistry: new ArtifactProcessorRegistry([
          {
            id: 'test.svg-to-png',
            process: () => ({ data: new Blob([png]), mediaType: 'image/png' }),
            supports: (source, profile) =>
              source.mediaType === 'image/svg+xml' && profile.mediaTypes.includes('image/png'),
            version: '1',
          },
        ]),
      });
      const stored = await artifacts.ingest({
        data: new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>']),
        declaredMediaType: 'image/svg+xml',
        filename: 'vector.svg',
        provenance: { type: 'upload' },
        scope: { id: 'account-1', type: 'account' },
      });
      stubFetch(() => sse(textDelta('hi')));

      await run(
        provider({}, { artifacts }),
        [
          message({
            content: [{ artifact: artifactRef(stored), type: 'artifact' }],
            role: 'user',
          }),
        ],
        [],
        { inputModalities: ['text', 'image'], modelId: 'vision', outputModalities: ['text'] },
      );

      expect((requests[0]?.body.messages as { content: unknown }[])[1]?.content).toEqual([
        { text: '[from test-broker:alice]\n', type: 'text' },
        {
          text:
            `[artifact id=${JSON.stringify(stored.artifactId)} name="vector.svg" ` +
            `media_type="image/svg+xml" bytes=${String(stored.size)}]\n`,
          type: 'text',
        },
        { image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' }, type: 'image_url' },
      ]);
    } finally {
      await database.close();
      try {
        rmSync(directory, { force: true, recursive: true });
      } catch {
        // Windows may briefly retain a SQLite handle.
      }
    }
  });

  test('keeps the descriptor when no compatible visual rendition exists', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nox-openai-unsupported-image-'));
    const database = await Database.open({ path: join(directory, 'nox.db') });
    try {
      const artifacts = await ArtifactPipeline.open({ dataDirectory: directory, database });
      const stored = await artifacts.ingest({
        data: new Blob(['<svg/>']),
        declaredMediaType: 'image/svg+xml',
        filename: 'vector.svg',
        provenance: { type: 'upload' },
        scope: { id: 'account-1', type: 'account' },
      });
      stubFetch(() => sse(textDelta('hi')));

      await run(
        provider({}, { artifacts }),
        [
          message({
            content: [{ artifact: artifactRef(stored), type: 'artifact' }],
            role: 'user',
          }),
        ],
        [],
        { inputModalities: ['text', 'image'], modelId: 'vision', outputModalities: ['text'] },
      );

      expect((requests[0]?.body.messages as { content: unknown }[])[1]?.content).toBe(
        '[from test-broker:alice]\n' +
          `[artifact id=${JSON.stringify(stored.artifactId)} name="vector.svg" ` +
          `media_type="image/svg+xml" bytes=${String(stored.size)}]\n`,
      );
    } finally {
      await database.close();
      try {
        rmSync(directory, { force: true, recursive: true });
      } catch {
        // Windows may briefly retain a SQLite handle.
      }
    }
  });

  test('keeps the descriptor when image processing fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nox-openai-broken-image-'));
    const database = await Database.open({ path: join(directory, 'nox.db') });
    try {
      const artifacts = await ArtifactPipeline.open({
        dataDirectory: directory,
        database,
        processorRegistry: new ArtifactProcessorRegistry([
          {
            id: 'test.broken-image',
            process: () => ({
              data: (async function* brokenImage() {
                await Promise.resolve();
                yield Uint8Array.of(0x01);
                throw new Error('decode failed');
              })(),
              mediaType: 'image/png',
            }),
            supports: () => true,
            version: '1',
          },
        ]),
      });
      const stored = await artifacts.ingest({
        data: new Blob(['<svg/>']),
        declaredMediaType: 'image/svg+xml',
        filename: 'broken.svg',
        provenance: { type: 'upload' },
        scope: { id: 'account-1', type: 'account' },
      });
      stubFetch(() => sse(textDelta('hi')));

      await run(
        provider({}, { artifacts }),
        [
          message({
            content: [{ artifact: artifactRef(stored), type: 'artifact' }],
            role: 'user',
          }),
        ],
        [],
        { inputModalities: ['text', 'image'], modelId: 'vision', outputModalities: ['text'] },
      );

      expect((requests[0]?.body.messages as { content: unknown }[])[1]?.content).toBe(
        '[from test-broker:alice]\n' +
          `[artifact id=${JSON.stringify(stored.artifactId)} name="broken.svg" ` +
          `media_type="image/svg+xml" bytes=${String(stored.size)}]\n`,
      );
    } finally {
      await database.close();
      try {
        rmSync(directory, { force: true, recursive: true });
      } catch {
        // Windows may briefly retain a SQLite handle.
      }
    }
  });

  test('marks a compacted turn as reference material rather than an instruction', async () => {
    stubFetch(() => sse(textDelta('hi')));

    await run(provider(), [
      message({
        compactedMessageIds: ['a'],
        content: [{ text: 'we discussed X', type: 'text' }],
        role: 'compacted',
      }),
    ]);

    expect((requests[0]?.body.messages as { content: string; role: string }[])[1]).toEqual({
      content: '[conversation summary]\nwe discussed X',
      role: 'user',
    });
  });

  test('rides a fold onto the assistant turn it replaced traffic for', async () => {
    stubFetch(() => sse(textDelta('hi')));

    await run(provider(), [
      message({ content: [{ text: 'working', type: 'text' }], role: 'assistant' }),
      message({
        anchorMessageId: 'assistant',
        content: [{ text: '[folded 3 calls]', type: 'text' }],
        foldedMessageIds: ['x'],
        role: 'folded',
      }),
    ]);

    const messages = requests[0]?.body.messages as unknown[];
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({ content: 'working\n[folded 3 calls]', role: 'assistant' });
  });

  test('drops reasoning instead of replaying it as assistant text', async () => {
    stubFetch(() => sse(textDelta('hi')));

    await run(provider(), [
      message({ content: [{ text: 'let me think', type: 'text' }], role: 'reasoning' }),
    ]);

    expect(requests[0]?.body.messages).toEqual([{ content: 'be brief', role: 'system' }]);
  });

  test('attaches a tool call to the assistant turn and answers it as a tool message', async () => {
    stubFetch(() => sse(textDelta('hi')));

    await run(provider(), [
      message({ content: [{ text: 'calling', type: 'text' }], role: 'assistant' }),
      message({ arguments: { value: 'x' }, name: 'echo', role: 'toolCall', trackId: 'call_1' }),
      message({
        execution: 'immediate',
        name: 'echo',
        response: [{ text: 'echoed', type: 'text' }],
        role: 'toolResponse',
        trackId: 'call_1',
      }),
    ]);

    expect(requests[0]?.body.messages).toEqual([
      { content: 'be brief', role: 'system' },
      {
        content: 'calling',
        role: 'assistant',
        tool_calls: [
          {
            function: { arguments: '{"value":"x"}', name: 'echo' },
            id: 'call_1',
            type: 'function',
          },
        ],
      },
      {
        content: expect.stringContaining('--- BEGIN UNTRUSTED DATA ') as unknown as string,
        role: 'tool',
        tool_call_id: 'call_1',
      },
    ]);
    expect(fenced((requests[0]?.body.messages as { content: string }[])[2]?.content)).toBe(
      'echoed',
    );
  });

  test('keeps tool responses contiguous and then presents returned images visually', async () => {
    stubFetch(() => sse(textDelta('hi')));

    await run(
      provider(),
      [
        message({ content: [], role: 'assistant' }),
        message({ arguments: {}, name: 'first', role: 'toolCall', trackId: 'call_1' }),
        message({ arguments: {}, name: 'second', role: 'toolCall', trackId: 'call_2' }),
        message({
          execution: 'immediate',
          name: 'first',
          response: [
            { text: 'candidate selected', type: 'text' },
            { source: { type: 'url', url: 'https://img.test/a.png' }, type: 'image' },
          ],
          role: 'toolResponse',
          trackId: 'call_1',
        }),
        message({
          execution: 'immediate',
          name: 'second',
          response: [{ text: 'metadata ready', type: 'text' }],
          role: 'toolResponse',
          trackId: 'call_2',
        }),
      ],
      [],
      {
        inputModalities: ['text', 'image'],
        modelId: 'gpt-vision',
        outputModalities: ['text'],
      },
    );

    expect(requests[0]?.body.messages).toEqual([
      { content: 'be brief', role: 'system' },
      {
        content: null,
        role: 'assistant',
        tool_calls: [
          { function: { arguments: '{}', name: 'first' }, id: 'call_1', type: 'function' },
          { function: { arguments: '{}', name: 'second' }, id: 'call_2', type: 'function' },
        ],
      },
      {
        content: expect.any(String) as unknown as string,
        role: 'tool',
        tool_call_id: 'call_1',
      },
      {
        content: expect.any(String) as unknown as string,
        role: 'tool',
        tool_call_id: 'call_2',
      },
      {
        content: [
          { text: '[media returned by first (call_1)]\n', type: 'text' },
          {
            text: expect.stringContaining('BEGIN UNTRUSTED DATA') as unknown as string,
            type: 'text',
          },
          { image_url: { url: 'https://img.test/a.png' }, type: 'image_url' },
          {
            text: expect.stringContaining('END UNTRUSTED DATA') as unknown as string,
            type: 'text',
          },
        ],
        role: 'user',
      },
    ]);

    const sent = requests[0]?.body.messages as { content: unknown }[];
    expect(fenced(sent[2]?.content)).toBe('candidate selected');
    expect(fenced(sent[3]?.content)).toBe('metadata ready');

    // The image travels as its own provider message, so it carries its own copy
    // of the fence — and the same nonce, so the two halves read as one result.
    const media = sent[4]?.content as { text?: string }[];
    const nonce = /BEGIN UNTRUSTED DATA (\S+) /.exec(String(media[1]?.text))?.[1];
    expect(nonce).toBeDefined();
    expect(media[3]?.text).toContain(`END UNTRUSTED DATA ${String(nonce)} `);
    expect(String(sent[2]?.content)).toContain(`BEGIN UNTRUSTED DATA ${String(nonce)} `);
  });

  test('refuses undeclared model input instead of silently discarding it', async () => {
    stubFetch(() => sse(textDelta('hi')));

    const events = await run(
      provider(),
      [
        message({
          content: [{ source: { type: 'url', url: 'https://img.test/a.png' }, type: 'image' }],
          role: 'user',
        }),
      ],
      [],
      {
        inputModalities: ['text'],
        modelId: 'text-only',
        outputModalities: ['text'],
      },
    );

    expect(events.at(-1)).toMatchObject({ error: { code: 'invalid_request' }, type: 'error' });
    expect(requests).toHaveLength(0);
  });

  test('reports modalities this adapter cannot encode even when the model accepts them', async () => {
    stubFetch(() => sse(textDelta('hi')));

    const events = await run(
      provider(),
      [
        message({
          content: [
            {
              source: {
                mediaType: 'audio/wav',
                type: 'url',
                url: 'https://audio.test/a.wav',
              },
              type: 'audio',
            },
          ],
          role: 'user',
        }),
      ],
      [],
      {
        inputModalities: ['text', 'audio'],
        modelId: 'audio-model',
        outputModalities: ['text'],
      },
    );

    expect(events.at(-1)).toMatchObject({ error: { code: 'invalid_request' }, type: 'error' });
    expect(requests).toHaveLength(0);
  });

  test('rides a fold onto a textless assistant anchor after reasoning', async () => {
    stubFetch(() => sse(textDelta('hi')));

    await run(provider(), [
      message({ content: [{ text: 'do it', type: 'text' }], role: 'user' }),
      message({ content: [{ text: 'thinking', type: 'text' }], role: 'reasoning' }),
      // ProviderStream materializes this turn when a model emits tool calls
      // without visible assistant text. The fold remains assistant-anchored.
      message({ content: [], messageId: 'anchor', role: 'assistant' }),
      message({
        anchorMessageId: 'anchor',
        content: [{ text: '[folded 2 calls]', type: 'text' }],
        foldedMessageIds: ['c1', 'r1'],
        role: 'folded',
      }),
    ]);

    expect(requests[0]?.body.messages).toEqual([
      { content: 'be brief', role: 'system' },
      { content: '[from test-broker:alice]\ndo it', role: 'user' },
      { content: '[folded 2 calls]', role: 'assistant' },
    ]);
  });

  test('surfaces a late deferred result as correlated user content', async () => {
    stubFetch(() => sse(textDelta('hi')));

    await run(provider(), [
      message({
        execution: 'deferredResult',
        name: 'build',
        response: [{ text: 'exit 0', type: 'text' }],
        role: 'toolResponse',
        trackId: 'call_9',
      }),
    ]);

    const late = (requests[0]?.body.messages as { content: string; role: string }[])[1];
    expect(late?.role).toBe('user');
    // The correlation header is Nox's own writing, so it stays outside.
    expect(late?.content.startsWith('[deferred result for build (call_9)]\n')).toBe(true);
    expect(fenced(late?.content.split('\n').slice(1).join('\n'))).toBe('exit 0');
  });
});

describe('OpenAICompletions session regression', () => {
  test('sends one tool result with the same nonce in every request of a session', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nox-openai-nonce-'));
    const database = await Database.open({ path: join(directory, 'nox.db') });
    const model: ModelConfig = {
      inputModalities: ['text'],
      modelId: 'gpt-test',
      outputModalities: ['text'],
    };

    stubFetch(() => {
      switch (requests.length) {
        case 1:
          return sse({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      function: { arguments: '{"value":"x"}', name: 'echo' },
                      id: 'call_1',
                      index: 0,
                    },
                  ],
                },
              },
            ],
          });
        case 2:
          return sse(textDelta('first turn done'));
        default:
          return sse(textDelta('done'));
      }
    });

    /** The nonce of every request that carried the fenced tool result. */
    function nonces(): string[] {
      return requests.flatMap((request) => {
        const wire = request.body.messages as { content: string; role: string }[];
        const result = wire.find((entry) => entry.role === 'tool');
        const found = /BEGIN UNTRUSTED DATA (\S+) ---/.exec(String(result?.content))?.[1];
        return found === undefined ? [] : [found];
      });
    }

    try {
      const session = await Session.open(database, provider(), model, {
        agentId: 'test',
        authorities: testCatalog(),
        authorization: permissiveAuthorization,
        // Folding would replace the pair with a placeholder and there would be
        // no second rendering of it to compare against.
        context: { foldMinReductionRatio: 1, tools: { echo: echoTool } },
        sessionId: 'stable-boundary-nonce',
        systemPrompt: 'be brief',
      });

      session.send('use echo', testOrigin());
      await session.idle;
      session.send('and again', testOrigin());
      await session.idle;
      await session.stop();

      // The nonce is minted once per response object and never persisted, so
      // this is what keeps the request prefix byte-identical between turns —
      // a nonce re-rolled per render would cost a full prompt-cache miss from
      // that message onward, every turn.
      const seen = nonces();
      expect(seen.length).toBeGreaterThan(1);
      expect(new Set(seen).size).toBe(1);
    } finally {
      await database.close();
      try {
        rmSync(directory, { force: true, recursive: true });
      } catch {
        // Windows may retain the SQLite handle briefly; the directory is disposable.
      }
    }
  });

  test('persists and replays a folded tool-only reasoning turn into the next request', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nox-openai-fold-'));
    const database = await Database.open({ path: join(directory, 'nox.db') });
    const model: ModelConfig = {
      inputModalities: ['text'],
      modelId: 'gpt-test',
      outputModalities: ['text'],
    };
    const bulkyEcho: Tool = {
      ...echoTool,
      prepare: () => ({
        run: () => Promise.resolve([{ text: 'echoed '.repeat(1000), type: 'text' as const }]),
        title: 'echo',
        type: 'immediate' as const,
      }),
    };

    stubFetch(() => {
      switch (requests.length) {
        case 1:
          return sse(
            { choices: [{ delta: { reasoning_content: 'thinking before the call' } }] },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        function: { arguments: '{"value":"x"}', name: 'echo' },
                        id: 'call_1',
                        index: 0,
                      },
                    ],
                  },
                },
              ],
            },
          );
        case 2:
          return sse(
            { choices: [{ delta: { reasoning_content: 'checking the result' } }] },
            textDelta('first turn done'),
          );
        case 3:
          return sse(textDelta('second turn done'));
        default:
          throw new Error(`Unexpected request ${String(requests.length)}.`);
      }
    });

    try {
      const instance = provider();
      const session = await Session.open(database, instance, model, {
        agentId: 'test',
        authorities: testCatalog(),
        authorization: permissiveAuthorization,
        context: { foldMinReductionRatio: 0.01, tools: { echo: bulkyEcho } },
        sessionId: 'folded-reasoning-turn',
        systemPrompt: 'be brief',
      });

      session.send('use echo', testOrigin());
      await session.idle;
      await session.stop();

      // ProviderStream inserted this assistant before the call, so the request
      // answering the tool result has a valid assistant/tool/tool sequence.
      const secondWire = requests[1]?.body.messages as { content: null | string; role: string }[];
      expect(secondWire.map(({ role }) => role)).toEqual(['system', 'user', 'assistant', 'tool']);
      expect(secondWire[2]).toMatchObject({ content: null, role: 'assistant' });

      // Reopen from storage, not from the live Context. The fold and its
      // synthetic assistant anchor must both survive and reconnect by ID.
      const resumed = await Session.open(database, instance, model, {
        agentId: 'test',
        authorities: testCatalog(),
        authorization: permissiveAuthorization,
        context: { foldMinReductionRatio: 0.01, tools: { echo: bulkyEcho } },
        sessionId: session.sessionId,
        systemPrompt: 'be brief',
      });
      const transcript = resumed.getTranscript();
      const anchor = transcript.find(
        (entry) => entry.role === 'assistant' && entry.content.length === 0,
      );
      const fold = transcript.find((entry) => entry.role === 'folded');

      expect(anchor?.role).toBe('assistant');
      expect(fold?.role === 'folded' ? fold.anchorMessageId : undefined).toBe(anchor?.messageId);

      resumed.send('what happened?', testOrigin());
      await resumed.idle;
      await resumed.stop();

      const replayedWire = requests[2]?.body.messages as { content: null | string; role: string }[];
      expect(
        replayedWire.some(
          (entry) =>
            entry.role === 'assistant' &&
            entry.content?.includes('-----Folded tool calls-----') === true,
        ),
      ).toBeTrue();
      expect(JSON.stringify(replayedWire)).not.toContain('thinking before the call');
      expect(JSON.stringify(replayedWire)).not.toContain('checking the result');
      expect(replayedWire.at(-1)).toEqual({
        content: '[from test-broker:alice]\nwhat happened?',
        role: 'user',
      });
    } finally {
      await database.close();
      try {
        rmSync(directory, { force: true, recursive: true });
      } catch {
        // Windows may retain the SQLite handle briefly; the directory is disposable.
      }
    }
  });
});

describe('OpenAICompletions streaming', () => {
  test('emits reasoning and text fragments and reports usage', async () => {
    stubFetch(() =>
      sse(
        { choices: [{ delta: { reasoning_content: 'thinking' } }] },
        textDelta('he'),
        textDelta('llo'),
        {
          choices: [],
          usage: {
            completion_tokens: 5,
            prompt_tokens: 11,
            prompt_tokens_details: { cached_tokens: 8 },
          },
        },
      ),
    );

    const events = await run(provider());

    expect(
      events.filter((event) => event.type === 'textFragment').map((event) => event.text),
    ).toEqual(['he', 'llo']);
    expect(events.filter((event) => event.type === 'reasoningFragment')).toHaveLength(1);

    const end = events.at(-1);
    expect(end?.type).toBe('end');
    expect(end?.type === 'end' ? end.usage : undefined).toEqual({
      cacheReadTokens: 8,
      inputTokens: 11,
      outputTokens: 5,
    });
  });

  test('accumulates a tool call split across chunks', async () => {
    stubFetch(() =>
      sse(
        {
          choices: [
            { delta: { tool_calls: [{ function: { name: 'ec' }, id: 'call_', index: 0 }] } },
          ],
        },
        { choices: [{ delta: { tool_calls: [{ function: { name: 'ho' }, id: '1', index: 0 }] } }] },
        { choices: [{ delta: { tool_calls: [{ function: { arguments: '{"val' }, index: 0 }] } }] },
        {
          choices: [{ delta: { tool_calls: [{ function: { arguments: 'ue":"x"}' }, index: 0 }] } }],
        },
      ),
    );

    const events = await run(provider());
    const toolCall = events.find((event) => event.type === 'toolCall');

    expect(toolCall?.type === 'toolCall' ? toolCall.toolCall : undefined).toMatchObject({
      arguments: { value: 'x' },
      name: 'echo',
      role: 'toolCall',
      trackId: 'call_1',
    });
  });

  test('reads a final data line that arrived without a trailing [DONE]', async () => {
    stubFetch(() => new Response(`data: ${JSON.stringify(textDelta('tail'))}`, { status: 200 }));

    const events = await run(provider());

    expect(
      events.filter((event) => event.type === 'textFragment').map((event) => event.text),
    ).toEqual(['tail']);
  });

  test('fails a tool call whose arguments are not valid JSON', async () => {
    stubFetch(() =>
      sse({
        choices: [
          {
            delta: {
              tool_calls: [{ function: { arguments: '{oops', name: 'echo' }, id: 'c1', index: 0 }],
            },
          },
        ],
      }),
    );

    const events = await run(provider());

    expect(events.at(-1)?.type).toBe('error');
  });
});

describe('OpenAICompletions error classification', () => {
  const cases: [label: string, status: number, body: unknown, code: ProviderErrorCode][] = [
    [
      'authentication',
      401,
      { error: { code: 'invalid_api_key', message: 'bad key' } },
      'authentication',
    ],
    ['rate limit', 429, { error: { message: 'slow down' } }, 'rate_limit'],
    [
      'context limit',
      400,
      { error: { message: 'This model maximum context length is 8192 tokens' } },
      'context_limit',
    ],
    [
      'usage limit',
      400,
      { error: { code: 'insufficient_quota', message: 'no credit' } },
      'usage_limit',
    ],
    ['invalid request', 422, { error: { message: 'bad field' } }, 'invalid_request'],
    ['unclassified', 500, { error: { message: 'boom' } }, 'provider_error'],
  ];

  for (const [label, status, body, code] of cases) {
    test(`classifies ${label} responses as ${code}`, async () => {
      stubFetch(() => Response.json(body, { status }));

      const events = await run(provider());
      const failure = events.at(-1);

      expect(failure?.type).toBe('error');
      expect(failure?.type === 'error' ? failure.error.code : undefined).toBe(code);
      expect(failure?.type === 'error' ? failure.error.provider : undefined).toBe(
        'openai_completions',
      );
    });
  }

  test('classifies a failure before response headers as a connection error', async () => {
    stubFetch(() => {
      throw new TypeError('socket hang up');
    });

    const events = await run(provider());
    const failure = events.at(-1);

    expect(failure?.type === 'error' && isProviderError(failure.error)).toBe(true);
    expect(failure?.type === 'error' ? failure.error.code : undefined).toBe('connection');
  });

  test('reports a stream error carried inside the event payload', async () => {
    stubFetch(() => sse({ error: { message: 'upstream exploded', type: 'server_error' } }));

    const events = await run(provider());
    const failure = events.at(-1);

    expect(failure?.type).toBe('error');
    expect(failure?.type === 'error' ? failure.error.message : '').toContain('upstream exploded');
  });
});
