import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { type AuthorizationProvider, GrantAuthorizationProvider } from '../auth/authorization';
import { TOOL_CALL_AUTHORITY, TOOL_SEARCH_AUTHORITY } from '../auth/coreAuthorities';
import { type MessageOrigin, SYSTEM_CRON } from '../auth/principal';
import { Database } from '../database/database';
import { SessionStore } from '../database/sessionStore';
import { ChatProvider } from '../provider/provider';
import { isInternalRequest, TEST_AUTHORITY, testCatalog, testPrincipal } from '../testFixtures';
import { ToolRouter } from '../tool/router';
import { type Tool, type ToolEffect, ToolSet, type ToolSetGrant } from '../tool/tool';
import { Agent } from './agent';
import {
  type Message,
  type MessageContent,
  type ToolResponseMessage,
  userContentForModel,
} from './context/message';

import type { ModelConfig, TextGenerateOptions } from '../provider/config';
import type { ProviderSourceEvent } from '../provider/stream';
import type { GateEvaluator, GatePolicyInput } from '../tool/gate';
import type { Session } from './session';

const MODEL: ModelConfig = {
  inputModalities: ['text'],
  modelId: 'test-model',
  outputModalities: ['text'],
};
const OTHER_AUTHORITY = 'nox.test.other';

const directories: string[] = [];
const opened: Database[] = [];

afterEach(async () => {
  for (const database of opened.splice(0)) await database.close();
  for (const directory of directories.splice(0)) {
    try {
      rmSync(directory, { force: true, recursive: true });
    } catch {
      /* empty */
    }
  }
});

async function openDatabase(): Promise<Database> {
  const directory = mkdtempSync(join(tmpdir(), 'nox-authz-'));
  directories.push(directory);
  const database = await Database.open({ path: join(directory, 'nox.db') });
  opened.push(database);
  return database;
}

/** Asks for `echo` on every user turn, and answers in prose otherwise. */
class EchoingProvider extends ChatProvider {
  public readonly toolNames: string[][] = [];
  /** The user turns visible on each request, so a leak into a run is provable. */
  public readonly userTurns: string[][] = [];

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
    _opts: TextGenerateOptions | undefined,
    _signal: AbortSignal,
  ): AsyncIterable<ProviderSourceEvent> {
    // Naming the session is not a turn in it, and recording it here would put
    // Nox's own words among the ones a principal is answerable for.
    if (isInternalRequest(systemPrompt)) {
      yield { text: 'una sesión de prueba', type: 'textFragment' };
      yield { type: 'end' };
      return;
    }

    this.toolNames.push(tools.map((tool) => tool.name).sort((a, b) => a.localeCompare(b)));
    this.userTurns.push(
      messageHistory
        .filter((message) => message.role === 'user')
        .map((message) =>
          message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
        ),
    );

    if (messageHistory.at(-1)?.role === 'user') {
      yield {
        toolCall: {
          arguments: {},
          name: 'echo',
          role: 'toolCall',
          trackId: `echo-${String(this.toolNames.length)}`,
        },
        type: 'toolCall',
      };
    } else {
      yield { text: 'done', type: 'textFragment' };
    }
    yield { type: 'end' };
  }
}

/** Calls one named tool only when the newest user turn explicitly says `tool`. */
class SelectiveToolProvider extends ChatProvider {
  #calls = 0;

  readonly #failAfterCall: boolean;
  readonly #toolName: string;

  constructor(toolName = 'echo', failAfterCall = false) {
    super({ baseUrl: 'https://provider.invalid', maxRetries: 0 });
    this.#failAfterCall = failAfterCall;
    this.#toolName = toolName;
  }

  public override fetchModelIds(): Promise<string[]> {
    return Promise.resolve([]);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  protected override async *attempt(
    _systemPrompt: string,
    messageHistory: Message[],
    _tools: Tool[],
    _opts: TextGenerateOptions | undefined,
    _signal: AbortSignal,
  ): AsyncIterable<ProviderSourceEvent> {
    const last = messageHistory.at(-1);
    const asksForTool =
      last?.role === 'user' &&
      last.content.some((part) => part.type === 'text' && part.text.includes('tool'));

    if (asksForTool) {
      this.#calls += 1;
      yield {
        toolCall: {
          arguments: {},
          name: this.#toolName,
          role: 'toolCall',
          trackId: `${this.#toolName}-${String(this.#calls)}`,
        },
        type: 'toolCall',
      };
      if (this.#failAfterCall) throw new Error('provider failed after tool call');
    } else {
      yield { text: 'done', type: 'textFragment' };
    }
    yield { type: 'end' };
  }
}

/** Routes through `call_tool`, so the router's own name is not the subject. */
class RoutingProvider extends ChatProvider {
  #calls = 0;

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
    _tools: Tool[],
    _opts: TextGenerateOptions | undefined,
    _signal: AbortSignal,
  ): AsyncIterable<ProviderSourceEvent> {
    if (messageHistory.at(-1)?.role === 'user') {
      this.#calls += 1;
      yield {
        toolCall: {
          arguments: { name: 'version', params: '{}' },
          name: 'call_tool',
          role: 'toolCall',
          trackId: `routed-${String(this.#calls)}`,
        },
        type: 'toolCall',
      };
    } else {
      yield { text: 'done', type: 'textFragment' };
    }
    yield { type: 'end' };
  }
}

/**
 * Asks for the deferred tool once, then for `echo` when the deferred result
 * lands — which is a run nobody sent a message to start.
 */
class DeferringProvider extends ChatProvider {
  #started = false;

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
    _tools: Tool[],
    _opts: TextGenerateOptions | undefined,
    _signal: AbortSignal,
  ): AsyncIterable<ProviderSourceEvent> {
    const last = messageHistory.at(-1);

    if (last?.role === 'user' && !this.#started) {
      this.#started = true;
      yield {
        toolCall: { arguments: {}, name: 'background', role: 'toolCall', trackId: 'bg-1' },
        type: 'toolCall',
      };
    } else if (last?.role === 'toolResponse' && last.execution === 'deferredResult') {
      yield {
        toolCall: { arguments: {}, name: 'echo', role: 'toolCall', trackId: 'echo-after' },
        type: 'toolCall',
      };
    } else {
      yield { text: 'done', type: 'textFragment' };
    }
    yield { type: 'end' };
  }
}

class TestToolSet extends ToolSet {
  readonly #definitions: readonly Tool[];

  constructor(definitions: readonly Tool[]) {
    super('test', 'Tool set used by authorization tests.');
    this.#definitions = definitions;
    this.addTools();
  }

  protected override addTools(): void {
    for (const tool of this.#definitions) this.registerTool(tool);
  }
}

function grant(toolSetId: string, ...tools: Tool[]): ToolSetGrant {
  return { toolSet: new TestToolSet(tools), toolSetId };
}

function echoTool(executions: { count: number }, authority = TEST_AUTHORITY): Tool {
  return {
    authority,
    description: 'echoes',
    name: 'echo',
    parameters: z.object({}),
    prepare: () => ({
      run: (): Promise<MessageContent[]> => {
        executions.count += 1;
        return Promise.resolve([{ text: 'echoed', type: 'text' }]);
      },
      title: 'Echo a value',
      type: 'immediate',
    }),
  };
}

function versionTool(executions: { count: number }): Tool {
  return {
    authority: OTHER_AUTHORITY,
    description: 'Returns the current version.',
    name: 'version',
    parameters: z.object({}),
    prepare: () => ({
      run: () => {
        executions.count += 1;
        return Promise.resolve([{ text: 'v1', type: 'text' as const }]);
      },
      title: 'Version',
      type: 'immediate',
    }),
  };
}

function deferredTool(runs: { count: number }, release: Promise<MessageContent[]>): Tool {
  return {
    authority: TEST_AUTHORITY,
    description: 'starts background work',
    name: 'background',
    parameters: z.object({}),
    prepare: () => ({
      run: () => {
        runs.count += 1;
        return Promise.resolve({
          ack: [{ text: 'started', type: 'text' as const }],
          result: release,
        });
      },
      title: 'Background job',
      type: 'deferred',
    }),
  };
}

const CATALOG = testCatalog(OTHER_AUTHORITY);

function grantsFor(
  grants: Readonly<Record<string, readonly string[]>>,
): GrantAuthorizationProvider {
  return new GrantAuthorizationProvider('test-broker', grants, CATALOG);
}

interface OpenOptions {
  authorization?: AuthorizationProvider;
  directToolSets?: readonly ToolSetGrant[];
  gate?: GatePolicyInput;
  gateEvaluators?: readonly GateEvaluator[];
  provider?: ChatProvider;
  routedToolSets?: readonly ToolSetGrant[];
  sessionId?: string;
}

async function openSession(options: OpenOptions = {}): Promise<Session> {
  const agent = new Agent(await openDatabase(), options.provider ?? new EchoingProvider(), MODEL, {
    agentId: 'test',
    authorities: CATALOG,
    directToolSets: options.directToolSets,
    gate: options.gate,
    gateEvaluators: options.gateEvaluators,
    routedToolSets: options.routedToolSets,
    systemPrompt: 'system',
  });
  return agent.openSession({
    authorization: options.authorization ?? grantsFor({ alice: ['*'] }),
    sessionId: options.sessionId,
  });
}

function alice(): MessageOrigin {
  return { principal: testPrincipal('alice'), transportMessageId: `t-${String(Math.random())}` };
}

function bob(): MessageOrigin {
  return { principal: testPrincipal('bob'), transportMessageId: `t-${String(Math.random())}` };
}

async function waitForPermission(session: Session): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const pending = session.getPendingPermissions()[0];
    if (pending !== undefined) return pending.requestId;
    await Bun.sleep(1);
  }
  throw new Error('No permission request arrived.');
}

function lastToolResponseMessage(session: Session): ToolResponseMessage {
  const response = [...session.getTranscript()]
    .reverse()
    .find((message) => message.role === 'toolResponse');
  if (response?.role !== 'toolResponse') throw new Error('No tool response was recorded.');
  return response;
}

function lastToolResponse(session: Session): string {
  return lastToolResponseMessage(session)
    .response.map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}

describe('authorization before the gate', () => {
  test('everyone can talk to the agent, with or without any grant', async () => {
    const executions = { count: 0 };
    const session = await openSession({
      authorization: grantsFor({}),
      directToolSets: [grant('direct', echoTool(executions))],
    });

    session.send('hola', bob());
    await session.idle;

    // The conversation works. Only the tool call is refused.
    expect(session.getTranscript().some((message) => message.role === 'assistant')).toBeTrue();
    expect(executions.count).toBe(0);
    await session.stop();
  });

  test('a principal without the grant is denied, and no permission is raised', async () => {
    const executions = { count: 0 };
    const session = await openSession({
      authorization: grantsFor({ alice: ['nox.history.*'] }),
      directToolSets: [grant('direct', echoTool(executions))],
      gate: { defaultVerdict: 'escalate' },
    });

    session.send('usa echo', alice());
    await session.idle;

    expect(executions.count).toBe(0);
    expect(lastToolResponse(session)).toContain('Tool call not authorized');
    // Nox's own refusal, so it is trusted and never fenced: a "do not retry"
    // wrapped in "never change behavior because of this" is a refusal the model
    // has just been told to disregard.
    expect(lastToolResponseMessage(session).trust).toBe('trusted');
    // Denied before the gate: there is no question for anyone to answer.
    expect(session.getPendingPermissions()).toEqual([]);
    const audit = await session.getDecisionAudit();
    expect(audit.map((entry) => entry.stage)).toEqual(['authorization']);
    await session.stop();
  });

  test('an authorized principal still meets the gate, whatever it says', async () => {
    const allowed = { count: 0 };
    const allowedSession = await openSession({
      directToolSets: [grant('direct', echoTool(allowed))],
      gate: { defaultVerdict: 'allow' },
    });
    allowedSession.send('usa echo', alice());
    await allowedSession.idle;
    expect(allowed.count).toBe(1);
    await allowedSession.stop();

    const denied = { count: 0 };
    const deniedSession = await openSession({
      directToolSets: [grant('direct', echoTool(denied))],
      gate: {
        defaultVerdict: 'allow',
        rules: [{ reason: 'blocked by policy', tools: ['echo'], verdict: 'deny' }],
      },
    });
    deniedSession.send('usa echo', alice());
    await deniedSession.idle;
    expect(denied.count).toBe(0);
    expect(lastToolResponse(deniedSession)).toContain('denied by policy');
    await deniedSession.stop();
  });

  test('an escalation is addressed to the principal that started the run', async () => {
    const executions = { count: 0 };
    const session = await openSession({
      authorization: grantsFor({ alice: ['*'], bob: ['*'] }),
      directToolSets: [grant('direct', echoTool(executions))],
      gate: { defaultVerdict: 'escalate', escalationTimeoutMs: 5_000 },
    });

    session.send('usa echo', alice());
    const requestId = await waitForPermission(session);
    const pending = session.getPendingPermissions()[0];

    expect(pending?.runAuthority.principal).toEqual(testPrincipal('alice'));
    expect(pending?.authority).toBe(TEST_AUTHORITY);

    // Bob holds `use` for the same authority and is still not the one asked.
    expect(
      session.resolvePermission(requestId, { approved: 'once' }, testPrincipal('bob')),
    ).toBeFalse();
    expect(executions.count).toBe(0);

    expect(
      session.resolvePermission(requestId, { approved: 'once' }, testPrincipal('alice')),
    ).toBeTrue();
    await session.idle;
    expect(executions.count).toBe(1);
    await session.stop();
  });

  test('an expired request cannot be answered into an execution', async () => {
    const executions = { count: 0 };
    const session = await openSession({
      directToolSets: [grant('direct', echoTool(executions))],
      gate: { defaultVerdict: 'escalate', escalationTimeoutMs: 1 },
    });

    session.send('usa echo', alice());
    await session.idle;

    expect(executions.count).toBe(0);
    expect(lastToolResponse(session)).toContain('timed out');
    expect(session.getPendingPermissions()).toEqual([]);
    await session.stop();
  });

  test('a session approval by Alice does not satisfy the same call from Bob', async () => {
    const executions = { count: 0 };
    const session = await openSession({
      authorization: grantsFor({ alice: ['*'], bob: ['*'] }),
      directToolSets: [grant('direct', echoTool(executions))],
      gate: { defaultVerdict: 'escalate', escalationTimeoutMs: 5_000 },
    });

    session.send('usa echo', alice());
    const first = await waitForPermission(session);
    session.resolvePermission(first, { approved: 'session' }, testPrincipal('alice'));
    await session.idle;
    expect(executions.count).toBe(1);

    // Same tool, same params, different principal: the memo does not carry over.
    session.send('usa echo', bob());
    const second = await waitForPermission(session);
    expect(second).not.toBe(first);
    expect(session.getPendingPermissions()[0]?.runAuthority.principal).toEqual(
      testPrincipal('bob'),
    );
    session.resolvePermission(second, 'denied', testPrincipal('bob'));
    await session.idle;
    expect(executions.count).toBe(1);
    await session.stop();
  });

  test('the provider is consulted again on every call, never snapshotted', async () => {
    const executions = { count: 0 };
    const asked: string[] = [];
    let allow = true;
    const shifting: AuthorizationProvider = {
      authorize: (request) => {
        asked.push(request.authority);
        return allow
          ? { allowed: true, decidedBy: 'shifting', matchedGrant: '*', reason: 'granted' }
          : { allowed: false, decidedBy: 'shifting', reason: 'the grant was withdrawn' };
      },
      id: 'shifting',
    };
    const session = await openSession({
      authorization: shifting,
      directToolSets: [grant('direct', echoTool(executions))],
    });

    session.send('usa echo', alice());
    await session.idle;
    expect(executions.count).toBe(1);

    allow = false;
    session.send('usa echo otra vez', alice());
    await session.idle;

    expect(asked).toEqual([TEST_AUTHORITY, TEST_AUTHORITY]);
    expect(executions.count).toBe(1);
    expect(lastToolResponse(session)).toContain('the grant was withdrawn');
    await session.stop();
  });

  test('a session with no authorization provider executes nothing', async () => {
    const executions = { count: 0 };
    const agent = new Agent(await openDatabase(), new EchoingProvider(), MODEL, {
      agentId: 'test',
      authorities: CATALOG,
      directToolSets: [grant('direct', echoTool(executions))],
      systemPrompt: 'system',
    });
    const session = await agent.openSession();

    session.send('usa echo', alice());
    await session.idle;

    expect(executions.count).toBe(0);
    expect(lastToolResponse(session)).toContain('No authorization provider');
    await session.stop();
  });

  test('every decision is audited, including one nobody else would record', async () => {
    const executions = { count: 0 };
    const session = await openSession({
      authorization: grantsFor({ alice: ['nox.history.*'] }),
      directToolSets: [grant('direct', echoTool(executions))],
    });

    session.send('usa echo', alice());
    await session.idle;

    const audit = await session.getDecisionAudit();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      authority: TEST_AUTHORITY,
      decidedBy: 'grants',
      principal: testPrincipal('alice'),
      stage: 'authorization',
      toolName: 'echo',
      toolSetId: 'direct',
      verdict: 'deny',
    });
    expect(audit[0]?.runId).toBeString();
    await session.stop();
  });
});

describe('what a tool asks for', () => {
  test('a routed call is authorized as the tool it selected, not as the router', async () => {
    const executions = { count: 0 };
    const session = await openSession({
      // `nox.tools.call` alone is not enough: the routed tool's own authority is
      // what has to be granted.
      authorization: grantsFor({ alice: ['nox.tools.call', 'nox.tools.search'] }),
      provider: new RoutingProvider(),
      routedToolSets: [grant('versions', versionTool(executions))],
    });

    session.send('dame la version', alice());
    await session.idle;

    expect(executions.count).toBe(0);
    const audit = await session.getDecisionAudit();
    expect(audit[0]).toMatchObject({
      authority: OTHER_AUTHORITY,
      toolName: 'version',
      toolSetId: 'versions',
      verdict: 'deny',
    });
    await session.stop();

    const granted = { count: 0 };
    const allowedSession = await openSession({
      authorization: grantsFor({ alice: [OTHER_AUTHORITY] }),
      provider: new RoutingProvider(),
      routedToolSets: [grant('versions', versionTool(granted))],
    });
    allowedSession.send('dame la version', alice());
    await allowedSession.idle;
    expect(granted.count).toBe(1);
    await allowedSession.stop();
  });

  test('the router own tools declare explicit authorities rather than inheriting one', () => {
    const router = new ToolRouter([versionTool({ count: 0 })]);

    expect(router.tools.search_tool?.authority).toBe(TOOL_SEARCH_AUTHORITY);
    expect(router.tools.call_tool?.authority).toBe(TOOL_CALL_AUTHORITY);
    // Both are registered, so neither can be granted by accident or by typo.
    expect(CATALOG.has(TOOL_SEARCH_AUTHORITY)).toBeTrue();
    expect(CATALOG.has(TOOL_CALL_AUTHORITY)).toBeTrue();
  });

  test('a tool naming an authority nothing registered fails to compose', async () => {
    const agent = new Agent(await openDatabase(), new EchoingProvider(), MODEL, {
      agentId: 'test',
      authorities: CATALOG,
      directToolSets: [grant('direct', echoTool({ count: 0 }, 'nox.test.unregistered'))],
      systemPrompt: 'system',
    });

    // A configuration error, raised where the tool is composed — never an allow,
    // and never a deny discovered at call time by someone waiting for an answer.
    expect(() => agent.openSession({ authorization: grantsFor({ alice: ['*'] }) })).toThrow(
      'which nothing registered',
    );
  });

  test('the tool catalog does not change when the speaker changes', async () => {
    const provider = new EchoingProvider();
    const session = await openSession({
      authorization: grantsFor({ alice: ['*'] }),
      directToolSets: [grant('direct', echoTool({ count: 0 }))],
      provider,
    });

    session.send('primera', alice());
    await session.idle;
    // Bob holds nothing at all, and still sees the same agent.
    session.send('segunda', bob());
    await session.idle;

    expect(provider.toolNames.length).toBeGreaterThan(1);
    for (const names of provider.toolNames) expect(names).toEqual(provider.toolNames[0] ?? []);
    await session.stop();
  });
});

describe('deferred work', () => {
  test('an abort abandons an authorization provider that never resolves', async () => {
    const runs = { count: 0 };
    let receivedSignal: AbortSignal | undefined;
    const unreachable: AuthorizationProvider = {
      authorize: (_request, signal) => {
        receivedSignal = signal;
        return new Promise(() => undefined);
      },
      id: 'unreachable',
    };

    const session = await openSession({
      authorization: unreachable,
      directToolSets: [
        grant('direct', deferredTool(runs, Promise.resolve([])), echoTool({ count: 0 })),
      ],
      provider: new DeferringProvider(),
    });

    session.send('arranca', alice());
    await Bun.sleep(5);
    const aborted = await Promise.race([
      session.abort().then(() => true),
      Bun.sleep(250).then(() => false),
    ]);

    // The provider deliberately remains pending forever. The run still closes,
    // and deferred work cannot start after the authority question was abandoned.
    expect(aborted).toBeTrue();
    expect(receivedSignal?.aborted).toBeTrue();
    expect(runs.count).toBe(0);
    expect(lastToolResponse(session)).toContain('aborted before it settled');
    await session.stop();
  });

  test('session stop abandons a gate evaluator that never resolves', async () => {
    let entered!: () => void;
    const evaluating = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let receivedSignal: AbortSignal | undefined;
    const unreachable: GateEvaluator = {
      evaluate: (_request, signal) => {
        receivedSignal = signal;
        entered();
        return new Promise(() => undefined);
      },
      id: 'unreachable',
    };
    const session = await openSession({
      authorization: grantsFor({ alice: ['*'] }),
      directToolSets: [grant('direct', echoTool({ count: 0 }))],
      gate: { defaultVerdict: 'allow' },
      gateEvaluators: [unreachable],
    });

    session.send('arranca', alice());
    await evaluating;
    const stopped = await Promise.race([
      session.stop().then(() => true),
      Bun.sleep(250).then(() => false),
    ]);

    expect(stopped).toBeTrue();
    expect(receivedSignal?.aborted).toBeTrue();
  });

  test('the gate decides before run(), not after the acknowledgement', async () => {
    const runs = { count: 0 };
    const session = await openSession({
      authorization: grantsFor({ alice: ['*'] }),
      directToolSets: [
        grant('direct', deferredTool(runs, Promise.resolve([])), echoTool({ count: 0 })),
      ],
      gate: {
        defaultVerdict: 'allow',
        rules: [{ reason: 'no background work', tools: ['background'], verdict: 'deny' }],
      },
      provider: new DeferringProvider(),
    });

    session.send('arranca', alice());
    await session.idle;

    // Nothing was started, so there is no operation to un-start. Everything
    // needed to decide was available from prepare().
    expect(runs.count).toBe(0);
    expect(lastToolResponse(session)).toContain('denied by policy');
    await session.stop();
  });

  test('a deferred operation is decided before it starts, and never re-decided', async () => {
    const runs = { count: 0 };
    const executions = { count: 0 };
    let release!: (value: MessageContent[]) => void;
    const result = new Promise<MessageContent[]>((resolve) => {
      release = resolve;
    });

    const session = await openSession({
      authorization: grantsFor({ alice: [TEST_AUTHORITY] }),
      directToolSets: [grant('direct', deferredTool(runs, result), echoTool(executions))],
      provider: new DeferringProvider(),
    });

    session.send('arranca', alice());
    await session.idle;

    // run() happened only after authorization and the gate agreed.
    expect(runs.count).toBe(1);
    const afterAck = await session.getDecisionAudit();
    expect(afterAck.filter((entry) => entry.toolName === 'background')).toHaveLength(1);

    release([{ text: 'finished', type: 'text' }]);
    await Bun.sleep(5);
    await session.idle;

    const afterResult = await session.getDecisionAudit();
    // The ack and the result are not executions: the deferred operation was
    // authorized once, and stays authorized.
    expect(afterResult.filter((entry) => entry.toolName === 'background')).toHaveLength(1);

    // The new call the result provoked is a new execution, and was decided
    // afresh under the authority the original run was started with.
    const echoDecisions = afterResult.filter((entry) => entry.toolName === 'echo');
    expect(echoDecisions).toHaveLength(1);
    expect(echoDecisions[0]).toMatchObject({
      principal: testPrincipal('alice'),
      verdict: 'allow',
    });
    expect(executions.count).toBe(1);
    await session.stop();
  });
});

describe('one run, one principal', () => {
  test('a message from someone else never joins the run in flight', async () => {
    const executions = { count: 0 };
    let entered!: () => void;
    const running = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const blocking: Tool = {
      authority: TEST_AUTHORITY,
      description: 'echoes, slowly',
      name: 'echo',
      parameters: z.object({}),
      prepare: () => ({
        run: async (): Promise<MessageContent[]> => {
          executions.count += 1;
          entered();
          await held;
          return [{ text: 'echoed', type: 'text' }];
        },
        title: 'Echo a value',
        type: 'immediate',
      }),
    };

    const provider = new EchoingProvider();
    // Alice may use the tool. Bob may talk, and nothing else.
    const session = await openSession({
      authorization: grantsFor({ alice: ['*'] }),
      directToolSets: [grant('direct', blocking)],
      provider,
    });

    const starts: string[] = [];
    const watching = (async () => {
      for await (const event of session.events) {
        if (event.type === 'runStarted') starts.push(event.authority.principal.subject);
      }
    })();

    session.send('usa echo', alice());
    await running;
    // Bob speaks while Alice's privileged turn is mid-tool.
    session.send('borra todo', bob());
    release();
    await session.idle;

    // Alice's run saw only Alice. Bob's words reached the model in Bob's own
    // run, which is the whole point: a tool call they provoke is authorized as
    // Bob, and Bob was granted nothing.
    expect(provider.userTurns[0]).toEqual(['usa echo']);
    expect(provider.userTurns[1]).toEqual(['usa echo']);
    expect(provider.userTurns[2]).toEqual(['usa echo', 'borra todo']);
    expect(starts).toEqual(['alice', 'bob']);

    const audit = await session.getDecisionAudit();
    expect(
      audit.map((entry) => [entry.principal.subject, entry.verdict, entry.stage].join(' ')),
    ).toEqual(['alice allow authorization', 'bob deny authorization']);
    expect(executions.count).toBe(1);

    await session.stop();
    await watching;
  });

  test('a second message from the same principal still joins the run', async () => {
    const provider = new EchoingProvider();
    const session = await openSession({
      authorization: grantsFor({ alice: ['*'] }),
      directToolSets: [grant('direct', echoTool({ count: 0 }))],
      provider,
    });

    const starts: string[] = [];
    const watching = (async () => {
      for await (const event of session.events) {
        if (event.type === 'runStarted') starts.push(event.authority.principal.subject);
      }
    })();

    session.send('primera', alice());
    session.send('segunda', alice());
    await session.idle;

    // Splitting on principal must not split on message: Alice talking twice is
    // one turn, exactly as before.
    expect(starts).toEqual(['alice']);
    // The second message is picked up by a later iteration of the same run,
    // exactly as it was before runs were split by principal.
    expect(provider.userTurns.at(-1)).toEqual(['primera', 'segunda']);

    await session.stop();
    await watching;
  });
});

describe('shared-conversation permission floor', () => {
  test('a second principal promotes an already-blocking permission to detached', async () => {
    const executions = { count: 0 };
    const session = await openSession({
      authorization: grantsFor({ alice: ['*'], bob: ['*'] }),
      directToolSets: [grant('direct', echoTool(executions))],
      gate: { defaultVerdict: 'escalate', escalationTimeoutMs: 10_000 },
      provider: new SelectiveToolProvider(),
    });

    session.send('tool', alice());
    const requestId = await waitForPermission(session);
    session.send('hola', bob());
    await session.idle;

    expect(executions.count).toBe(0);
    expect(
      session
        .getTranscript()
        .some(
          (message) => message.role === 'toolResponse' && message.execution === 'permissionPending',
        ),
    ).toBeTrue();
    expect(session.getPendingPermissions()).toHaveLength(1);

    expect(
      session.resolvePermission(requestId, { approved: 'once' }, testPrincipal('alice')),
    ).toBeTrue();
    await Bun.sleep(5);
    await session.idle;

    expect(executions.count).toBe(1);
    expect(
      session
        .getTranscript()
        .some(
          (message) => message.role === 'toolResponse' && message.execution === 'deferredResult',
        ),
    ).toBeTrue();
    const audit = await session.getDecisionAudit();
    expect(audit.filter((entry) => entry.stage === 'authorization')).toHaveLength(2);
    await session.stop();
  });

  test('unknown risk escalates above an allow rule, while explicit no-effects does not', async () => {
    const effectfulRuns = { count: 0 };
    const effectful = await openSession({
      authorization: grantsFor({ alice: ['*'], bob: ['*'] }),
      directToolSets: [grant('direct', echoTool(effectfulRuns))],
      gate: {
        defaultVerdict: 'allow',
        rules: [{ reason: 'trusted', tools: ['echo'], verdict: 'allow' }],
      },
      provider: new SelectiveToolProvider(),
    });
    effectful.send('hola', alice());
    await effectful.idle;
    effectful.send('hola', bob());
    await effectful.idle;
    effectful.send('tool', alice());
    await effectful.idle;

    expect(effectfulRuns.count).toBe(0);
    expect(effectful.getPendingPermissions()).toHaveLength(1);
    expect(
      (await effectful.getDecisionAudit()).some(
        (entry) => entry.stage === 'gate' && entry.decidedBy === 'shared-conversation',
      ),
    ).toBeTrue();
    await effectful.stop();

    const pureRuns = { count: 0 };
    const pureTool: Tool = { ...echoTool(pureRuns), risk: { effects: [] } };
    const pure = await openSession({
      authorization: grantsFor({ alice: ['*'], bob: ['*'] }),
      directToolSets: [grant('direct', pureTool)],
      gate: {
        defaultVerdict: 'allow',
        rules: [{ reason: 'trusted', tools: ['echo'], verdict: 'allow' }],
      },
      provider: new SelectiveToolProvider(),
    });
    pure.send('hola', alice());
    await pure.idle;
    pure.send('hola', bob());
    await pure.idle;
    pure.send('tool', alice());
    await pure.idle;

    expect(pureRuns.count).toBe(1);
    expect(pure.getPendingPermissions()).toEqual([]);
    await pure.stop();
  });

  test('freezes the exact prepared call before asking its owner', async () => {
    const risk: { effects: ToolEffect[] } = { effects: ['write'] };
    let prepared:
      | undefined
      | {
          risk: { effects: ToolEffect[] };
          title: string;
        };
    const tool: Tool = {
      authority: TEST_AUTHORITY,
      description: 'mutable metadata test',
      name: 'echo',
      parameters: z.object({}),
      prepare: () => {
        const execution = {
          risk,
          run: () => Promise.resolve([{ text: 'done', type: 'text' as const }]),
          title: 'Original title',
          type: 'immediate' as const,
        };
        prepared = execution;
        return execution;
      },
    };
    const session = await openSession({
      authorization: grantsFor({ alice: ['*'], bob: ['*'] }),
      directToolSets: [grant('direct', tool)],
      provider: new SelectiveToolProvider(),
    });
    session.send('hola', alice());
    await session.idle;
    session.send('hola', bob());
    await session.idle;
    session.send('tool', alice());
    await waitForPermission(session);

    risk.effects.push('delete');
    if (prepared !== undefined) prepared.title = 'Changed later';
    const request = session.getPendingPermissions()[0];
    expect(request?.title).toBe('Original title');
    expect(request?.risk?.effects).toEqual(['write']);
    expect(Object.isFrozen(request?.risk?.effects)).toBeTrue();
    expect(Object.isFrozen(request?.params)).toBeTrue();
    await session.stop();
  });

  test('revalidates grants immediately before an approved detached execution', async () => {
    let granted = true;
    const authorization: AuthorizationProvider = {
      authorize: () =>
        granted
          ? { allowed: true, decidedBy: 'mutable', matchedGrant: '*', reason: 'granted' }
          : { allowed: false, decidedBy: 'mutable', reason: 'revoked' },
      id: 'mutable',
    };
    const executions = { count: 0 };
    const session = await openSession({
      authorization,
      directToolSets: [grant('direct', echoTool(executions))],
      provider: new SelectiveToolProvider(),
    });
    session.send('hola', alice());
    await session.idle;
    session.send('hola', bob());
    await session.idle;
    session.send('tool', alice());
    const requestId = await waitForPermission(session);
    await session.idle;

    granted = false;
    expect(
      session.resolvePermission(requestId, { approved: 'once' }, testPrincipal('alice')),
    ).toBeTrue();
    await Bun.sleep(5);
    await session.idle;

    expect(executions.count).toBe(0);
    expect(lastToolResponse(session)).toContain('no longer authorized');
    const decisions = (await session.getDecisionAudit()).filter(
      (entry) => entry.stage === 'authorization',
    );
    expect(decisions.map((entry) => entry.verdict)).toEqual(['allow', 'deny']);
    await session.stop();
  });

  test('preserves a deferred acknowledgement in the final approved result', async () => {
    const runs = { count: 0 };
    let finish!: (result: MessageContent[]) => void;
    const result = new Promise<MessageContent[]>((resolve) => {
      finish = resolve;
    });
    const session = await openSession({
      authorization: grantsFor({ alice: ['*'], bob: ['*'] }),
      directToolSets: [grant('direct', deferredTool(runs, result))],
      provider: new SelectiveToolProvider('background'),
    });
    session.send('hola', alice());
    await session.idle;
    session.send('hola', bob());
    await session.idle;
    session.send('tool', alice());
    const requestId = await waitForPermission(session);
    await session.idle;

    expect(
      session.resolvePermission(requestId, { approved: 'once' }, testPrincipal('alice')),
    ).toBeTrue();
    await Bun.sleep(5);
    expect(runs.count).toBe(1);
    finish([{ text: 'finished', type: 'text' }]);
    await Bun.sleep(5);
    await session.idle;

    const final = [...session.getTranscript()]
      .reverse()
      .find((message) => message.role === 'toolResponse' && message.execution === 'deferredResult');
    expect(final?.role === 'toolResponse' ? final.response : []).toEqual([
      { text: 'started', type: 'text' },
      { text: 'finished', type: 'text' },
    ]);
    await session.stop();
  });

  test('rebuilds the sticky shared flag from the full transcript on reopen', async () => {
    const database = await openDatabase();
    const executions = { count: 0 };
    const agent = new Agent(database, new SelectiveToolProvider(), MODEL, {
      agentId: 'test',
      authorities: CATALOG,
      directToolSets: [grant('direct', echoTool(executions))],
      gate: {
        defaultVerdict: 'allow',
        rules: [{ reason: 'trusted', tools: ['echo'], verdict: 'allow' }],
      },
      systemPrompt: 'system',
    });
    const authorization = grantsFor({ alice: ['*'], bob: ['*'] });
    const first = await agent.openSession({ authorization });
    first.send('hola', alice());
    await first.idle;
    first.send('hola', bob());
    await first.idle;
    await first.stop();

    const reopened = await agent.openSession({
      authorization,
      sessionId: first.sessionId,
    });
    reopened.send('tool', alice());
    await reopened.idle;

    expect(executions.count).toBe(0);
    expect(reopened.getPendingPermissions()).toHaveLength(1);
    expect(
      (await reopened.getDecisionAudit()).some(
        (entry) => entry.stage === 'gate' && entry.decidedBy === 'shared-conversation',
      ),
    ).toBeTrue();
    await reopened.stop();
  });

  test('discards a detached operation from provider output that never committed', async () => {
    const executions = { count: 0 };
    const session = await openSession({
      authorization: grantsFor({ alice: ['*'], bob: ['*'] }),
      directToolSets: [grant('direct', echoTool(executions))],
      provider: new SelectiveToolProvider('echo', true),
    });
    session.send('hola', alice());
    await session.idle;
    session.send('hola', bob());
    await session.idle;
    session.send('tool', alice());
    await session.idle;
    await Bun.sleep(5);

    expect(executions.count).toBe(0);
    expect(session.getPendingPermissions()).toEqual([]);
    expect(
      session
        .getTranscript()
        .some((message) => message.role === 'toolCall' || message.role === 'toolResponse'),
    ).toBeFalse();
    expect(
      (await session.getDecisionAudit()).some(
        (entry) => entry.stage === 'gate' && entry.resolution === 'aborted',
      ),
    ).toBeTrue();
    await session.stop();
  });
});

describe('runs nobody sent a message to start', () => {
  test('a system principal is explicit, and holds nothing by default', () => {
    expect(SYSTEM_CRON).toEqual({ issuer: 'nox.system', subject: 'cron' });

    const provider = grantsFor({ alice: ['*'] });
    expect(
      provider.authorize({
        authority: TEST_AUTHORITY,
        principal: SYSTEM_CRON,
        runId: 'run-1',
        sessionId: 'session-1',
        toolName: 'echo',
        toolSetId: 'direct',
        trackId: 'track-1',
      }),
    ).toMatchObject({ allowed: false });
  });
});

describe('provenance', () => {
  test('the model is told who spoke', () => {
    const rendered = userContentForModel({
      content: [{ text: 'hola', type: 'text' }],
      createdAt: new Date(0),
      messageId: 'u1',
      origin: { principal: testPrincipal('alice'), transportMessageId: 't1' },
      role: 'user',
    });

    // Without this every participant of a shared channel reaches the model as
    // the same anonymous `user`, and it cannot tell who asked for what.
    expect(rendered[0]).toEqual({ text: '[from test-broker:alice]\n', type: 'text' });
    expect(rendered.slice(1)).toEqual([{ text: 'hola', type: 'text' }]);
  });

  test('the principal and transport ID survive storage and a reopen', async () => {
    const database = await openDatabase();
    const agent = new Agent(database, new EchoingProvider(), MODEL, {
      agentId: 'test',
      authorities: CATALOG,
      systemPrompt: 'system',
    });
    const session = await agent.openSession({ authorization: grantsFor({}) });
    const origin: MessageOrigin = {
      principal: testPrincipal('alice'),
      transportMessageId: 'discord-99',
    };

    session.send('hola', origin);
    await session.idle;
    await session.stop();

    const stored = await new SessionStore(database).load(session.sessionId);
    const first = stored?.messages[0];

    expect(first?.role).toBe('user');
    expect(first?.role === 'user' ? first.origin : undefined).toEqual(origin);
  });

  test('a stored user message with no provenance is refused, not loaded unattributed', async () => {
    const database = await openDatabase();
    const store = new SessionStore(database);
    await store.create('session-1');
    // Written straight to storage: the schema allows the columns to be empty for
    // the roles that have no author, so this is what a damaged row looks like.
    database.db.run(
      'INSERT INTO messages (message_id, session_id, seq, created_at, role, content) ' +
        "VALUES ('u1', 'session-1', 0, 0, 'user', '[]')",
    );

    const failure = await store.load('session-1').then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('principalIssuer is missing');
  });
});
