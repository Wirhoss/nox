import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { Database } from '../database/database';
import { ChatProvider } from '../provider/provider';
import {
  permissiveAuthorization,
  TEST_AUTHORITY,
  testCatalog,
  testOrigin,
  testPrincipal,
} from '../testFixtures';
import { type Tool, ToolSet, type ToolSetGrant } from '../tool/tool';
import { Agent } from './agent';

import type { ModelConfig, TextGenerateOptions } from '../provider/config';
import type { ProviderSourceEvent } from '../provider/stream';
import type { PermissionRequest } from '../tool/gate';
import type { Message, MessageContent } from './context/message';
import type { Session } from './session';

const MODEL: ModelConfig = { modelId: 'test-model', type: 'text' };

interface Request {
  history: Message[];
  modelId?: string;
  systemPrompt: string;
  toolNames: string[];
}

const directories: string[] = [];
const opened: Database[] = [];

afterEach(async () => {
  for (const database of opened.splice(0)) await database.close();
  for (const directory of directories.splice(0)) {
    // Windows keeps the SQLite file handle briefly after close(); the temp
    // directory is disposable either way, so a failed unlink is not a failure.
    try {
      rmSync(directory, { force: true, recursive: true });
    } catch {
      /* empty */
    }
  }
});

async function openDatabase(): Promise<Database> {
  const directory = mkdtempSync(join(tmpdir(), 'nox-agent-'));
  directories.push(directory);
  const database = await Database.open({ path: join(directory, 'nox.db') });
  opened.push(database);
  return database;
}

class RecordingProvider extends ChatProvider {
  public readonly requests: Request[] = [];

  constructor() {
    super({ baseUrl: 'https://provider.invalid', maxRetries: 0 });
  }

  public override fetchModelIds(): Promise<string[]> {
    return Promise.resolve([]);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  protected override async *attempt(
    systemPrompt: string,
    messageHistory: Message[],
    tools: Tool[],
    opts: TextGenerateOptions | undefined,
    _signal: AbortSignal,
  ): AsyncIterable<ProviderSourceEvent> {
    this.requests.push({
      history: [...messageHistory],
      modelId: opts?.model?.modelId,
      systemPrompt,
      toolNames: tools.map((tool) => tool.name),
    });
    yield { text: 'ok', type: 'textFragment' };
    yield { type: 'end' };
  }
}

class ToolCallingProvider extends ChatProvider {
  public override fetchModelIds(): Promise<string[]> {
    return Promise.resolve([]);
  }

  constructor() {
    super({ baseUrl: 'https://provider.invalid', maxRetries: 0 });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  protected override async *attempt(
    _systemPrompt: string,
    messageHistory: Message[],
    _tools: Tool[],
    _opts: TextGenerateOptions | undefined,
    _signal: AbortSignal,
  ): AsyncIterable<ProviderSourceEvent> {
    if (messageHistory.at(-1)?.role === 'user') {
      yield {
        toolCall: {
          arguments: {},
          name: 'echo',
          role: 'toolCall',
          trackId: `echo-${String(messageHistory.length)}`,
        },
        type: 'toolCall',
      };
    } else {
      yield { text: 'done', type: 'textFragment' };
    }
    yield { type: 'end' };
  }
}

class RoutingProvider extends ChatProvider {
  public readonly toolNames: string[][] = [];

  constructor() {
    super({ baseUrl: 'https://provider.invalid', maxRetries: 0 });
  }

  public override fetchModelIds(): Promise<string[]> {
    return Promise.resolve([]);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  protected override async *attempt(
    _systemPrompt: string,
    messageHistory: Message[],
    tools: Tool[],
    _opts: TextGenerateOptions | undefined,
    _signal: AbortSignal,
  ): AsyncIterable<ProviderSourceEvent> {
    this.toolNames.push(tools.map((tool) => tool.name));

    if (messageHistory.at(-1)?.role === 'user') {
      yield {
        toolCall: {
          arguments: { name: 'version', params: '{}' },
          name: 'call_tool',
          role: 'toolCall',
          trackId: `version-${String(this.toolNames.length)}`,
        },
        type: 'toolCall',
      };
    } else {
      yield { text: 'done', type: 'textFragment' };
    }
    yield { type: 'end' };
  }
}

function echoTool(): Tool {
  return {
    authority: TEST_AUTHORITY,
    description: 'echoes',
    name: 'echo',
    parameters: z.object({}),
    prepare: () => ({
      run: (): Promise<MessageContent[]> => Promise.resolve([{ text: 'echoed', type: 'text' }]),
      title: 'echo',
      type: 'immediate',
    }),
  };
}

function versionTool(version: string): Tool {
  return {
    authority: TEST_AUTHORITY,
    description: 'Returns the current version.',
    name: 'version',
    parameters: z.object({}),
    prepare: () => ({
      run: () => Promise.resolve([{ text: version, type: 'text' as const }]),
      title: `Version ${version}`,
      type: 'immediate',
    }),
  };
}

class TestToolSet extends ToolSet {
  readonly #definitions: readonly Tool[];

  constructor(definitions: readonly Tool[]) {
    super('test', 'Tool set used by agent tests.');
    this.#definitions = definitions;
    this.addTools();
  }

  protected override addTools(): void {
    for (const tool of this.#definitions) this.registerTool(tool);
  }
}

function toolSet(...tools: Tool[]): ToolSet {
  return new TestToolSet(tools);
}

function grant(toolSetId: string, ...tools: Tool[]): ToolSetGrant {
  return { toolSet: toolSet(...tools), toolSetId };
}

async function waitForPermission(session: Session): Promise<PermissionRequest> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const pending = session.getPendingPermissions()[0];
    if (pending !== undefined) return pending;
    await Bun.sleep(1);
  }
  throw new Error('Permission request did not appear.');
}

describe('Agent', () => {
  test('holds a tool before execution until the session approves it', async () => {
    let executions = 0;
    const guarded = {
      ...echoTool(),
      prepare: () => ({
        run: () => {
          executions += 1;
          return Promise.resolve([{ text: 'echoed', type: 'text' as const }]);
        },
        title: 'Echo a value',
        type: 'immediate' as const,
      }),
      risk: {
        effects: ['write'] as const,
        resources: [{ kind: 'file' as const, value: '/outside/result.txt' }],
      },
    };
    const agent = new Agent(await openDatabase(), new ToolCallingProvider(), MODEL, {
      agentId: 'test',
      authorities: testCatalog(),
      directToolSets: [grant('direct', guarded)],
      gate: {
        defaultVerdict: 'allow',
        escalationTimeoutMs: 1_000,
        heuristics: { allowedRoots: ['/workspace'] },
      },
      systemPrompt: 'system',
    });
    const session = await agent.openSession({ authorization: permissiveAuthorization });

    session.send('use echo', testOrigin());
    const pending = await waitForPermission(session);

    expect(executions).toBe(0);
    expect(pending).toMatchObject({
      signals: [{ code: 'outside_allowed_root', severity: 'approval' }],
      title: 'Echo a value',
      toolName: 'echo',
      toolSetId: 'direct',
    });
    expect(
      session.resolvePermission(pending.requestId, { approved: 'once' }, testPrincipal()),
    ).toBeTrue();
    await session.idle;

    expect(executions).toBe(1);
    expect(session.getTranscript().some((message) => message.role === 'toolResponse')).toBeTrue();
    const events = [];
    for await (const event of session.events) {
      events.push(event.type);
      if (event.type === 'runCompleted') break;
    }
    expect(events).toContain('permissionRequested');
    expect(events).toContain('permissionResolved');

    // Both halves of the pipeline land in one timeline, in the order they ran.
    const audit = await session.getDecisionAudit();
    expect(audit.map((entry) => entry.stage)).toEqual(['authorization', 'gate']);
    expect(audit[0]).toMatchObject({
      authority: TEST_AUTHORITY,
      principal: testPrincipal(),
      toolName: 'echo',
      verdict: 'allow',
    });
    expect(audit[1]).toMatchObject({
      authority: TEST_AUTHORITY,
      decidedBy: 'heuristics',
      principal: testPrincipal(),
      resolution: 'approved',
      resolvedBy: testPrincipal(),
      scope: 'once',
      toolName: 'echo',
      toolSetId: 'direct',
      verdict: 'escalate',
    });
    expect(audit[1]?.resolvedAt).toBeInstanceOf(Date);
    await session.stop();

    const reopened = await agent.openSession({
      authorization: permissiveAuthorization,
      sessionId: session.sessionId,
    });
    expect(await reopened.getDecisionAudit()).toEqual(audit);
    await reopened.stop();
  });

  test('turns a policy denial into a paired error response without executing', async () => {
    let executions = 0;
    const guarded = {
      ...echoTool(),
      prepare: () => ({
        run: () => {
          executions += 1;
          return Promise.resolve([]);
        },
        title: 'Echo',
        type: 'immediate' as const,
      }),
    };
    const agent = new Agent(await openDatabase(), new ToolCallingProvider(), MODEL, {
      agentId: 'test',
      authorities: testCatalog(),
      directToolSets: [grant('direct', guarded)],
      gate: {
        defaultVerdict: 'allow',
        rules: [{ reason: 'blocked by policy', tools: ['echo'], verdict: 'deny' }],
      },
      systemPrompt: 'system',
    });
    const session = await agent.openSession({ authorization: permissiveAuthorization });

    session.send('use echo', testOrigin());
    await session.idle;

    const response = session.getTranscript().find((message) => message.role === 'toolResponse');
    expect(executions).toBe(0);
    expect(response).toMatchObject({ isError: true, name: 'echo', role: 'toolResponse' });
    expect(session.getPendingPermissions()).toEqual([]);
    expect(await session.getDecisionAudit()).toMatchObject([
      { stage: 'authorization', toolName: 'echo', verdict: 'allow' },
      {
        decidedBy: 'rules',
        reason: 'blocked by policy',
        resolution: undefined,
        stage: 'gate',
        toolName: 'echo',
        verdict: 'deny',
      },
    ]);
    await session.stop();
  });

  test('gates the selected routed tool rather than the call_tool wrapper', async () => {
    const agent = new Agent(await openDatabase(), new RoutingProvider(), MODEL, {
      agentId: 'test',
      authorities: testCatalog(),
      gate: {
        defaultVerdict: 'allow',
        rules: [
          {
            reason: 'version access needs approval',
            tools: ['version'],
            toolSets: ['versions'],
            verdict: 'escalate',
          },
        ],
      },
      routedToolSets: [grant('versions', versionTool('one'))],
      systemPrompt: 'system',
    });
    const session = await agent.openSession({ authorization: permissiveAuthorization });

    session.send('check version', testOrigin());
    const pending = await waitForPermission(session);

    expect(pending).toMatchObject({
      reason: 'version access needs approval',
      toolName: 'version',
      toolSetId: 'versions',
    });
    session.resolvePermission(pending.requestId, { approved: 'once' }, testPrincipal());
    await session.idle;

    const response = session
      .getTranscript()
      .find((message) => message.role === 'toolResponse' && message.name === 'call_tool');
    expect(response?.role === 'toolResponse' ? response.response : []).toEqual([
      { text: 'one', type: 'text' },
    ]);
    await session.stop();
  });

  test('sessions opened from the same tool configuration send the same request head', async () => {
    const provider = new RecordingProvider();
    const agent = new Agent(await openDatabase(), provider, MODEL, {
      agentId: 'test',
      authorities: testCatalog(),
      directToolSets: [grant('direct', echoTool())],
      systemPrompt: 'you are nox',
    });

    const first = await agent.openSession({ authorization: permissiveAuthorization });
    const second = await agent.openSession({ authorization: permissiveAuthorization });
    first.send('hi', testOrigin());
    await first.idle;
    second.send('hi', testOrigin());
    await second.idle;

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]?.systemPrompt).toBe('you are nox');
    expect(provider.requests[1]?.systemPrompt).toBe('you are nox');
    expect(provider.requests[0]?.toolNames).toEqual(provider.requests[1]?.toolNames ?? []);
    expect(provider.requests[0]?.toolNames).toContain('echo');
    expect(provider.requests[0]?.toolNames).not.toContain('call_tool');
    expect(provider.requests[0]?.toolNames).not.toContain('search_tool');

    await first.stop();
    await second.stop();
  });

  test('new and loaded sessions snapshot the current direct and routed tools', async () => {
    const provider = new RoutingProvider();
    const directToolSets: ToolSetGrant[] = [
      grant('direct-alpha', { ...echoTool(), name: 'alpha' }),
    ];
    const routedToolSets: ToolSetGrant[] = [grant('versions', versionTool('one'))];
    const agent = new Agent(await openDatabase(), provider, MODEL, {
      agentId: 'test',
      authorities: testCatalog(),
      directToolSets,
      routedToolSets,
      systemPrompt: 'system',
    });

    const openingFirst = agent.openSession({
      authorization: permissiveAuthorization,
      sessionId: 'shared',
    });
    directToolSets.push(grant('direct-beta', { ...echoTool(), name: 'beta' }));
    routedToolSets[0] = grant('versions', versionTool('two'));
    const first = await openingFirst;

    first.send('first', testOrigin());
    await first.idle;
    const firstResponse = first.getTranscript().find((message) => message.role === 'toolResponse');
    expect(firstResponse?.role === 'toolResponse' ? firstResponse.response : []).toEqual([
      { text: 'one', type: 'text' },
    ]);
    expect(provider.toolNames[0]).toContain('alpha');
    expect(provider.toolNames[0]).not.toContain('beta');
    expect(provider.toolNames[0]).toContain('call_tool');
    expect(provider.toolNames[0]).toContain('search_tool');
    expect(provider.toolNames[0]).not.toContain('version');
    await first.stop();

    const loaded = await agent.openSession({
      authorization: permissiveAuthorization,
      sessionId: 'shared',
    });
    loaded.send('second', testOrigin());
    await loaded.idle;
    const loadedResponses = loaded
      .getTranscript()
      .filter((message) => message.role === 'toolResponse');
    const latest = loadedResponses.at(-1);
    expect(latest?.role === 'toolResponse' ? latest.response : []).toEqual([
      { text: 'two', type: 'text' },
    ]);
    expect(provider.toolNames[2]).toContain('alpha');
    expect(provider.toolNames[2]).toContain('beta');
    expect(provider.toolNames[2]).not.toContain('version');

    await loaded.stop();
  });

  test('rejects ambiguous direct and routed tool assignments before opening', async () => {
    const shared = toolSet(versionTool('one'));
    const agent = new Agent(await openDatabase(), new RecordingProvider(), MODEL, {
      agentId: 'test',
      authorities: testCatalog(),
      directToolSets: [{ toolSet: shared, toolSetId: 'direct' }],
      routedToolSets: [{ toolSet: shared, toolSetId: 'routed' }],
      systemPrompt: 'system',
    });

    expect(() => agent.openSession({ authorization: permissiveAuthorization })).toThrow(
      'Tool version cannot be both direct and routed.',
    );
  });

  test('uses the separately configured provider and model for compaction', async () => {
    const mainProvider = new RecordingProvider();
    const compactionProvider = new RecordingProvider();
    const agent = new Agent(await openDatabase(), mainProvider, MODEL, {
      agentId: 'test',
      authorities: testCatalog(),
      compactionModel: { modelId: 'compact-model', type: 'text' },
      compactionProvider,
      context: {
        compactAtRatio: 0.5,
        compactGuardBeginningTokens: 0,
        compactGuardEndTokens: 0,
        compactMinTokens: 1,
        contextWindow: 100,
        reserveForOutput: 1,
        tokenCounter: (text) => text.length,
      },
      systemPrompt: 'system',
    });

    const session = await agent.openSession({ authorization: permissiveAuthorization });
    session.send(
      'a long message that puts this deliberately tiny context under pressure',
      testOrigin(),
    );
    await session.idle;

    expect(compactionProvider.requests).toHaveLength(1);
    expect(compactionProvider.requests[0]?.modelId).toBe('compact-model');
    expect(mainProvider.requests).toHaveLength(1);
    expect(mainProvider.requests[0]?.modelId).toBe('test-model');
    await session.stop();
  });

  test('sessions from one agent keep separate transcripts', async () => {
    const provider = new RecordingProvider();
    const agent = new Agent(await openDatabase(), provider, MODEL, {
      agentId: 'test',
      authorities: testCatalog(),
      systemPrompt: 'system',
    });

    const first = await agent.openSession({ authorization: permissiveAuthorization });
    const second = await agent.openSession({ authorization: permissiveAuthorization });
    first.send('only in the first', testOrigin());
    await first.idle;

    expect(first.getTranscript()).toHaveLength(2);
    expect(second.getTranscript()).toHaveLength(0);
    expect(first.sessionId).not.toBe(second.sessionId);

    await first.stop();
    await second.stop();
  });

  test('a session resumes by id with its history intact', async () => {
    const database = await openDatabase();
    const provider = new RecordingProvider();
    const agent = new Agent(database, provider, MODEL, {
      agentId: 'test',
      authorities: testCatalog(),
      systemPrompt: 'system',
    });

    const session = await agent.openSession({ title: 'first run' });
    session.send('remember this', testOrigin());
    await session.idle;
    await session.stop();

    const resumed = await agent.openSession({
      authorization: permissiveAuthorization,
      sessionId: session.sessionId,
    });
    expect(resumed.getTranscript().map((message) => message.role)).toEqual(['user', 'assistant']);

    resumed.send('and this', testOrigin());
    await resumed.idle;
    expect(provider.requests.at(-1)?.history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);

    await resumed.stop();
  });

  test('an unknown session id starts a session under that name', async () => {
    const agent = new Agent(await openDatabase(), new RecordingProvider(), MODEL, {
      agentId: 'test',
      authorities: testCatalog(),
      systemPrompt: 'system',
    });

    const session = await agent.openSession({
      authorization: permissiveAuthorization,
      sessionId: 'discord-channel-42',
    });

    expect(session.sessionId).toBe('discord-channel-42');
    expect(session.getTranscript()).toHaveLength(0);
    await session.stop();
  });
});
