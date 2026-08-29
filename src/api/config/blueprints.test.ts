import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  authorities,
  type ChatProvider,
  httpChatProviderConfigSchema,
  memories,
  type Memory,
  memoryContribution,
  providerContribution,
  providers,
  type Tool,
  ToolSet,
  toolSetBaseConfigSchema,
  toolSetContribution,
  toolSets,
} from '@nox/extension-api';
import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { AuthorityCatalog } from '../../auth/authority';
import { CORE_AUTHORITIES } from '../../auth/coreAuthorities';
import { Config } from '../../config/config';
import { readEnvConfig } from '../../config/env';
import { SecretStore } from '../../config/secrets';
import { Database } from '../../database/database';
import { ContributionRegistry } from '../../extensions/contribution';
import { DisposableStore } from '../../extensions/disposable';
import { ToolSetCatalog } from '../../extensions/toolSetCatalog';
import { silentLogger } from '../../logger/logger';
import { RegistrationWindow } from '../auth/registration';
import { AuthStore } from '../auth/store';
import { ApiServer } from '../server';
import { ConfigStore } from './store';

const databases: Database[] = [];
const directories: string[] = [];
const servers: ApiServer[] = [];

const PASSWORD = 'correct-horse-battery';
const TEST_EXTENSION = 'test.extension';

/** A blueprint naming only what the fixture configures. */
const NOX = { model: 'gpt-test', provider: 'main', systemPrompt: 'be exact' };

/** A tool the fake set exposes, under an authority the fixture also contributes. */
function tool(name: string): Tool {
  return {
    authority: `${TEST_EXTENSION}.use`,
    description: `The ${name} tool.`,
    name,
    parameters: z.object({}),
    prepare: () => ({
      risk: { effects: ['read'], reversible: true },
      run: () => Promise.resolve([{ text: name, type: 'text' as const }]),
      title: name,
      type: 'immediate' as const,
    }),
    risk: { effects: ['read'], reversible: true },
  };
}

/**
 * A real tool set rather than a stand-in: what the store now validates is what
 * an instance actually exposes, so a fixture whose sets expose nothing would
 * test nothing. It honours `enabledTools`, as every ToolSet does.
 */
class FakeTools extends ToolSet {
  readonly #names: readonly string[];

  constructor(config: { enabledTools?: readonly string[] }) {
    super('Fake tools', 'Tools that exist only in this test.', config.enabledTools);
    this.#names = ['fetch', 'index', 'summarize'];
    this.addTools();
  }

  protected override addTools(): void {
    for (const name of this.#names) this.registerTool(tool(name));
  }
}

/**
 * Provider, tool-set and authority kinds that exist only here. The sections that
 * hold them are assembled from the registry, so a fixture has to contribute
 * before the configuration naming them can be read at all.
 */
function registry(): ContributionRegistry {
  const contributions = new ContributionRegistry();
  const scoped = contributions.scoped(TEST_EXTENSION, new DisposableStore());

  scoped.register(authorities, `${TEST_EXTENSION}.use`, {
    description: 'Use a tool from the fake set.',
  });
  scoped.register(
    memories,
    'fake_memory',
    memoryContribution({
      instances: 'many',
      configSchema: z.object({ type: z.literal('fake_memory') }),
      create: () =>
        ({
          recall: () => ({ memories: [] }),
          retain: () => undefined,
        }) satisfies Memory,
    }),
  );
  scoped.register(
    providers,
    'fake_provider',
    providerContribution({
      instances: 'many',
      configSchema: httpChatProviderConfigSchema.extend({ type: z.literal('fake_provider') }),
      create: () => ({}) as unknown as ChatProvider,
    }),
  );
  scoped.register(
    toolSets,
    'fake_tools',
    toolSetContribution({
      instances: 'many',
      configSchema: toolSetBaseConfigSchema.extend({ type: z.literal('fake_tools') }),
      create: (config) => new FakeTools(config),
    }),
  );

  return contributions;
}

/** The catalog bootstrap would build from the same contributions. */
function authorityCatalog(contributions: ContributionRegistry): AuthorityCatalog {
  return AuthorityCatalog.from([
    ...CORE_AUTHORITIES,
    ...contributions.list(authorities).map((contribution) => ({
      description: contribution.value.description,
      id: contribution.id,
      ownerExtensionId: contribution.extensionId,
    })),
  ]);
}

interface NoxOptions {
  blueprints?: Record<string, unknown>;
}

interface BlueprintNox {
  readonly config: Config;
  readonly directory: string;
  readonly headers: Record<string, string>;
  readonly url: string;
}

/** A claimed Nox with one account logged in and the blueprint routes mounted. */
async function blueprintNox(options: NoxOptions = {}): Promise<BlueprintNox> {
  const directory = await mkdtemp(join(tmpdir(), 'nox-blueprints-'));
  directories.push(directory);

  await mkdir(join(directory, 'blueprints'), { recursive: true });
  for (const [agentId, blueprint] of Object.entries(options.blueprints ?? { nox: NOX })) {
    await writeFile(join(directory, 'blueprints', `${agentId}.json`), JSON.stringify(blueprint));
  }
  await writeFile(
    join(directory, 'memories.json'),
    JSON.stringify({ memory: { type: 'fake_memory' } }),
  );
  await writeFile(
    join(directory, 'providers.json'),
    JSON.stringify({ main: { baseUrl: 'https://main.test', type: 'fake_provider' } }),
  );
  await writeFile(
    join(directory, 'toolsets.json'),
    JSON.stringify({
      internet: { type: 'fake_tools' },
      mirror: { type: 'fake_tools' },
      narrow: { enabledTools: ['fetch'], type: 'fake_tools' },
    }),
  );
  const config = await Config.load(readEnvConfig({ CONFIG_DIR: directory, NODE_ENV: 'test' }), {
    logger: silentLogger,
  });
  const contributions = registry();
  await config.resolve(contributions);

  const database = await Database.open({ logger: silentLogger, path: join(directory, 'nox.db') });
  databases.push(database);
  const secretStore = await SecretStore.open({
    dataDirectory: directory,
    database,
    logger: silentLogger,
  });
  const store = await AuthStore.open({ database, dataDirectory: directory, logger: silentLogger });
  const account = await store.register('esteban', PASSWORD);
  const tokens = await store.openSession(account.accountId);

  const server = ApiServer.create({
    auth: { registration: RegistrationWindow.closed(), store },
    config: new ConfigStore({
      authorities: () => authorityCatalog(contributions),
      config,
      contributions,
      toolSets: new ToolSetCatalog({
        configured: () => config.get('toolSets'),
        contributions,
        secretStore,
      }),
    }),
    host: '127.0.0.1',
    logger: silentLogger,
    port: 0,
  });
  await server.listen();
  servers.push(server);

  return {
    config,
    directory,
    headers: {
      authorization: `Bearer ${tokens.accessToken}`,
      'content-type': 'application/json',
    },
    url: `${server.url}/api`,
  };
}

/** What is actually on disk for one agent, which is the only copy there is. */
async function onDisk(directory: string, agentId: string): Promise<unknown> {
  return JSON.parse(await readFile(join(directory, 'blueprints', `${agentId}.json`), 'utf8'));
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.dispose()));
  await Promise.all(databases.splice(0).map((database) => database.close()));
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      // Windows can retain a SQLite handle briefly after close; the OS temp
      // directory is disposable, so cleanup timing is not the assertion here.
      await rm(directory, { force: true, recursive: true }).catch(() => undefined);
    }),
  );
});

describe('reading blueprints', () => {
  test('lists every configured agent by ID, in a stable order', async () => {
    const nox = await blueprintNox({
      blueprints: { nox: NOX, watcher: { ...NOX, systemPrompt: 'watch' }, archivist: NOX },
    });

    const response = await fetch(`${nox.url}/config/blueprints`, { headers: nox.headers });
    const body = (await response.json()) as { value: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(Object.keys(body.value)).toEqual(['archivist', 'nox', 'watcher']);
  });

  test('reads one back with the defaults the schema resolved', async () => {
    const nox = await blueprintNox();

    const response = await fetch(`${nox.url}/config/blueprints/nox`, { headers: nox.headers });
    const body = (await response.json()) as { entryId: string; value: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.entryId).toBe('nox');
    expect(body.value).toMatchObject({
      maxIterations: 90,
      systemPrompt: 'be exact',
      toolSets: { direct: [], routed: [] },
    });
  });

  test('answers 404 for an agent nothing defines', async () => {
    const nox = await blueprintNox();

    const response = await fetch(`${nox.url}/config/blueprints/ghost`, { headers: nox.headers });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'entry_not_found' });
  });

  test('says nothing at all without a token', async () => {
    const nox = await blueprintNox();

    const response = await fetch(`${nox.url}/config/blueprints`);

    // A blueprint is the whole of what an agent will do; unauthenticated is the
    // one way it must never be readable.
    expect(response.status).toBe(401);
  });
});

describe('writing blueprints', () => {
  test('creates one, writes the file, and reports hot activation', async () => {
    const nox = await blueprintNox();

    const response = await fetch(`${nox.url}/config/blueprints/watcher`, {
      body: JSON.stringify({ ...NOX, systemPrompt: 'watch', toolSets: { direct: ['internet'] } }),
      headers: nox.headers,
      method: 'POST',
    });
    const body = (await response.json()) as {
      restartRequired: boolean;
      value: { systemPrompt: string };
    };

    expect(response.status).toBe(201);
    expect(body.restartRequired).toBeFalse();
    expect(body.value.systemPrompt).toBe('watch');

    // Written through the loader, so the file holds the resolved document a
    // hand-edited one would have been rewritten into.
    expect(await onDisk(nox.directory, 'watcher')).toMatchObject({
      maxIterations: 90,
      systemPrompt: 'watch',
      toolSets: { direct: ['internet'], routed: [] },
    });
    expect(Object.keys(nox.config.get('blueprints')).sort()).toEqual(['nox', 'watcher']);
  });

  test('refuses to create over an agent that already exists', async () => {
    const nox = await blueprintNox();

    const response = await fetch(`${nox.url}/config/blueprints/nox`, {
      body: JSON.stringify({ ...NOX, systemPrompt: 'overwritten' }),
      headers: nox.headers,
      method: 'POST',
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'entry_exists' });
    expect(nox.config.get('blueprints').nox?.systemPrompt).toBe('be exact');
  });

  test('replaces one whole through PUT, and refuses to invent one', async () => {
    const nox = await blueprintNox();

    const replaced = await fetch(`${nox.url}/config/blueprints/nox`, {
      body: JSON.stringify({ ...NOX, maxIterations: 5, systemPrompt: 'be brief' }),
      headers: nox.headers,
      method: 'PUT',
    });

    expect(replaced.status).toBe(200);
    expect(nox.config.get('blueprints').nox).toMatchObject({
      maxIterations: 5,
      systemPrompt: 'be brief',
    });

    const missing = await fetch(`${nox.url}/config/blueprints/ghost`, {
      body: JSON.stringify(NOX),
      headers: nox.headers,
      method: 'PUT',
    });

    // Creating is what POST is for, and a PUT that invented an agent from a
    // mistyped name would be an agent nobody meant to configure.
    expect(missing.status).toBe(404);
  });

  test('selects exactly one configured memory with a resolved token budget', async () => {
    const nox = await blueprintNox();

    const response = await fetch(`${nox.url}/config/blueprints/remembering`, {
      body: JSON.stringify({ ...NOX, memory: { id: 'memory' } }),
      headers: nox.headers,
      method: 'POST',
    });
    const body = (await response.json()) as { value: Record<string, unknown> };

    expect(response.status).toBe(201);
    expect(body.value).toMatchObject({ memory: { id: 'memory', maxTokens: 2048 } });
    expect(await onDisk(nox.directory, 'remembering')).toMatchObject({
      memory: { id: 'memory', maxTokens: 2048 },
    });
  });

  test('refuses a blueprint naming a memory nothing configures', async () => {
    const nox = await blueprintNox();

    const response = await fetch(`${nox.url}/config/blueprints/broken-memory`, {
      body: JSON.stringify({ ...NOX, memory: { id: 'absent' } }),
      headers: nox.headers,
      method: 'POST',
    });
    const body = (await response.json()) as { error: string; problems: string[] };

    expect(response.status).toBe(422);
    expect(body.error).toBe('unknown_reference');
    expect(body.problems).toEqual(['memories.json configures no memory "absent"']);
  });

  test('refuses a blueprint naming a provider nothing configures', async () => {
    const nox = await blueprintNox();

    const response = await fetch(`${nox.url}/config/blueprints/broken`, {
      body: JSON.stringify({ ...NOX, provider: 'absent' }),
      headers: nox.headers,
      method: 'POST',
    });
    const body = (await response.json()) as { error: string; problems: string[] };

    // Bootstrap refuses to start on this, so accepting the write would be
    // answering 201 for a Nox that no longer boots.
    expect(response.status).toBe(422);
    expect(body.error).toBe('unknown_reference');
    expect(body.problems).toEqual(['providers.json configures no provider "absent"']);

    // Rejected between parsing and writing, so no file was left behind.
    const reread = await fetch(`${nox.url}/config/blueprints/broken`, { headers: nox.headers });
    expect(reread.status).toBe(404);
  });

  test('refuses a blueprint naming a tool set nothing configures', async () => {
    const nox = await blueprintNox();

    const response = await fetch(`${nox.url}/config/blueprints/broken`, {
      body: JSON.stringify({ ...NOX, toolSets: { direct: ['nowhere'] } }),
      headers: nox.headers,
      method: 'POST',
    });
    const body = (await response.json()) as { error: string; problems: string[] };

    expect(response.status).toBe(422);
    expect(body.error).toBe('unknown_reference');
    expect(body.problems[0]).toContain('toolsets.json does not configure');
  });

  test('refuses a tool set granted twice in one list', async () => {
    const nox = await blueprintNox();

    const response = await fetch(`${nox.url}/config/blueprints/greedy`, {
      body: JSON.stringify({
        ...NOX,
        toolSets: { direct: ['internet', { id: 'internet', tools: ['fetch'] }] },
      }),
      headers: nox.headers,
      method: 'POST',
    });
    const body = (await response.json()) as { error: string; problems: string[] };

    // `internet` is configured, so the duplicate is the only thing wrong: this
    // fails for the reason it claims to.
    expect(response.status).toBe(422);
    expect(body.problems[0]).toContain('granted more than once');
  });

  test('refuses an allowlist naming a tool the set does not expose', async () => {
    const nox = await blueprintNox();

    const response = await fetch(`${nox.url}/config/blueprints/typo`, {
      body: JSON.stringify({
        ...NOX,
        toolSets: { direct: [{ id: 'internet', tools: ['fetc'] }] },
      }),
      headers: nox.headers,
      method: 'POST',
    });
    const body = (await response.json()) as { problems: string[] };

    // The whole reason the store opens the instance: this is knowable only from
    // the built tool set, and granting nothing in silence is the alternative.
    expect(response.status).toBe(422);
    expect(body.problems[0]).toContain('does not expose tool fetc');
  });

  test('judges the allowlist against what the instance exposes, not what it could', async () => {
    const nox = await blueprintNox();

    const response = await fetch(`${nox.url}/config/blueprints/narrowed`, {
      body: JSON.stringify({
        ...NOX,
        toolSets: { direct: [{ id: 'narrow', tools: ['summarize'] }] },
      }),
      headers: nox.headers,
      method: 'POST',
    });
    const body = (await response.json()) as { problems: string[] };

    // `narrow` is the same kind as `internet`, cut down by its own enabledTools.
    // The blueprint may only grant what that instance actually exposes.
    expect(response.status).toBe(422);
    expect(body.problems[0]).toContain('does not expose tool summarize');

    const allowed = await fetch(`${nox.url}/config/blueprints/narrowed`, {
      body: JSON.stringify({ ...NOX, toolSets: { direct: [{ id: 'narrow', tools: ['fetch'] }] } }),
      headers: nox.headers,
      method: 'POST',
    });

    expect(allowed.status).toBe(201);
  });

  test('refuses two tool sets that answer to the same tool name', async () => {
    const nox = await blueprintNox();

    const response = await fetch(`${nox.url}/config/blueprints/ambiguous`, {
      body: JSON.stringify({ ...NOX, toolSets: { direct: ['internet', 'mirror'] } }),
      headers: nox.headers,
      method: 'POST',
    });
    const body = (await response.json()) as { problems: string[] };

    // Two instances of one kind expose the same names. A session would refuse
    // to open on this, so the write that would cause it is refused instead.
    expect(response.status).toBe(422);
    expect(body.problems[0]).toContain('granted by more than one tool set');
  });

  test('refuses the same tools as both direct and routed', async () => {
    const nox = await blueprintNox();

    const response = await fetch(`${nox.url}/config/blueprints/confused`, {
      body: JSON.stringify({
        ...NOX,
        toolSets: { direct: ['internet'], routed: ['mirror'] },
      }),
      headers: nox.headers,
      method: 'POST',
    });
    const body = (await response.json()) as { problems: string[] };

    expect(response.status).toBe(422);
    expect(body.problems[0]).toContain('cannot be both direct and routed');
  });

  test('accepts a blueprint that grants part of a set', async () => {
    const nox = await blueprintNox();

    const response = await fetch(`${nox.url}/config/blueprints/reader`, {
      body: JSON.stringify({
        ...NOX,
        toolSets: { direct: [{ id: 'internet', tools: ['fetch', 'index'] }] },
      }),
      headers: nox.headers,
      method: 'POST',
    });

    expect(response.status).toBe(201);
    expect(await onDisk(nox.directory, 'reader')).toMatchObject({
      toolSets: { direct: [{ id: 'internet', tools: ['fetch', 'index'] }], routed: [] },
    });
  });

  test('judges a posted blueprint by the same schema a hand-edited file gets', async () => {
    const nox = await blueprintNox();

    const invalid = await fetch(`${nox.url}/config/blueprints/broken`, {
      body: JSON.stringify({ provider: 'main' }),
      headers: nox.headers,
      method: 'POST',
    });

    expect(invalid.status).toBe(422);
    expect((await invalid.json()) as { error: string }).toMatchObject({
      error: 'invalid_config',
    });

    const unknownKey = await fetch(`${nox.url}/config/blueprints/broken`, {
      body: JSON.stringify({ ...NOX, temperture: 0.7 }),
      headers: nox.headers,
      method: 'POST',
    });

    // A typo the route quietly stripped would be a setting the operator
    // believes they configured. The loader rejects it in a file; so does this.
    expect(unknownKey.status).toBe(422);
    expect((await unknownKey.json()) as { detail: string }).toMatchObject({
      error: 'invalid_config',
    });

    const composedMemories = await fetch(`${nox.url}/config/blueprints/broken`, {
      body: JSON.stringify({ ...NOX, memory: [{ id: 'memory' }, { id: 'memory' }] }),
      headers: nox.headers,
      method: 'POST',
    });

    // Memory is a singleton choice on the blueprint, never a backend fan-in.
    expect(composedMemories.status).toBe(422);
    expect((await composedMemories.json()) as { error: string }).toMatchObject({
      error: 'invalid_config',
    });
  });
});

describe('removing blueprints', () => {
  test('removes the file and forgets the agent', async () => {
    const nox = await blueprintNox({
      blueprints: { nox: NOX, watcher: { ...NOX, systemPrompt: 'watch' } },
    });

    const response = await fetch(`${nox.url}/config/blueprints/watcher`, {
      headers: nox.headers,
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      entryId: 'watcher',
      restartRequired: false,
      section: 'blueprints',
    });
    expect(Object.keys(nox.config.get('blueprints'))).toEqual(['nox']);
    expect(await onDisk(nox.directory, 'watcher').catch(() => 'gone')).toBe('gone');
  });

  test('allows the last agent to be removed while the control plane stays repairable', async () => {
    const nox = await blueprintNox();

    const response = await fetch(`${nox.url}/config/blueprints/nox`, {
      headers: nox.headers,
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
    expect(Object.keys(nox.config.get('blueprints'))).toEqual([]);
  });

  test('answers 404 for an agent nothing defines', async () => {
    const nox = await blueprintNox();

    const response = await fetch(`${nox.url}/config/blueprints/ghost`, {
      headers: nox.headers,
      method: 'DELETE',
    });

    expect(response.status).toBe(404);
  });
});
