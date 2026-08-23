import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { AuthorityCatalog } from '../../auth/authority';
import { CORE_AUTHORITIES } from '../../auth/coreAuthorities';
import { Config } from '../../config/config';
import { readEnvConfig } from '../../config/env';
import { SecretStore } from '../../config/secrets';
import { Database } from '../../database/database';
import { ContributionRegistry } from '../../extensions/contribution';
import {
  brokerBaseConfigSchema,
  brokerContribution,
  brokers,
} from '../../extensions/contribution-points/brokers';
import { providerContribution, providers } from '../../extensions/contribution-points/providers';
import {
  toolSetBaseConfigSchema,
  toolSetContribution,
  toolSets,
} from '../../extensions/contribution-points/toolsets';
import { DisposableStore } from '../../extensions/disposable';
import { ToolSetCatalog } from '../../extensions/toolSetCatalog';
import { silentLogger } from '../../logger/logger';
import { providerBaseConfigSchema } from '../../provider/config';
import { ToolSet } from '../../tool/tool';
import { RegistrationWindow } from '../auth/registration';
import { AuthStore } from '../auth/store';
import { ApiServer } from '../server';
import { ConfigStore } from './store';

import type { Broker } from '../../gateway/broker';
import type { ChatProvider } from '../../provider/provider';

const databases: Database[] = [];
const directories: string[] = [];
const servers: ApiServer[] = [];

const PASSWORD = 'correct-horse-battery';
const TEST_EXTENSION = 'test.extension';

/** A blueprint naming only what the fixture configures. */
const NOX = { model: 'gpt-test', provider: 'main', systemPrompt: 'be exact' };

/** A provider instance of the only kind this fixture registers. */
const PROVIDER = { baseUrl: 'https://main.test', type: 'fake_provider' };

/** Never built here: these routes validate configuration, they do not compose it. */
class FakeTools extends ToolSet {
  constructor(config: { enabledTools?: readonly string[] }) {
    super('Fake tools', 'Tools that exist only in this test.', config.enabledTools);
    this.addTools();
  }

  protected override addTools(): void {
    for (const name of ['fake_read', 'fake_write']) {
      this.registerTool({
        authority: `test.extension.${name}`,
        description: `${name} test capability.`,
        name,
        parameters: z.object({}),
        prepare: () => ({
          run: () => Promise.resolve([]),
          title: name,
          type: 'immediate',
        }),
      });
    }
  }
}

/**
 * Provider and tool-set kinds that exist only here. The sections holding them
 * are assembled from the registry, so nothing can configure one before a
 * fixture has contributed it — which is exactly the condition these routes have
 * to answer for.
 */
function registry(): ContributionRegistry {
  const contributions = new ContributionRegistry();
  const scoped = contributions.scoped(TEST_EXTENSION, new DisposableStore());

  scoped.register(
    brokers,
    'fake_broker',
    brokerContribution({
      configSchema: brokerBaseConfigSchema.extend({ type: z.literal('fake_broker') }),
      create: () => ({}) as Broker,
    }),
  );
  scoped.register(
    providers,
    'fake_provider',
    providerContribution({
      configSchema: providerBaseConfigSchema.extend({ type: z.literal('fake_provider') }),
      create: () => ({}) as unknown as ChatProvider,
    }),
  );
  scoped.register(
    toolSets,
    'fake_tools',
    toolSetContribution({
      configSchema: toolSetBaseConfigSchema.extend({ type: z.literal('fake_tools') }),
      create: (config) => new FakeTools(config),
    }),
  );

  return contributions;
}

interface NoxOptions {
  blueprints?: Record<string, unknown>;
  brokers?: Record<string, unknown>;
  /** Left unresolved, the contributed sections have no value to administer. */
  resolve?: boolean;
}

interface ConfigNox {
  readonly config: Config;
  readonly directory: string;
  readonly headers: Record<string, string>;
  readonly url: string;
}

/** A claimed Nox with one account logged in and the config routes mounted. */
async function configNox(options: NoxOptions = {}): Promise<ConfigNox> {
  const directory = await mkdtemp(join(tmpdir(), 'nox-config-'));
  directories.push(directory);

  await mkdir(join(directory, 'blueprints'), { recursive: true });
  for (const [agentId, blueprint] of Object.entries(options.blueprints ?? { nox: NOX })) {
    await writeFile(join(directory, 'blueprints', `${agentId}.json`), JSON.stringify(blueprint));
  }
  await writeFile(join(directory, 'brokers.json'), JSON.stringify(options.brokers ?? {}));
  await writeFile(join(directory, 'providers.json'), JSON.stringify({ main: PROVIDER }));
  await writeFile(
    join(directory, 'toolsets.json'),
    JSON.stringify({ internet: { type: 'fake_tools' } }),
  );

  const config = await Config.load(readEnvConfig({ CONFIG_DIR: directory, NODE_ENV: 'test' }), {
    logger: silentLogger,
  });
  const contributions = registry();
  if (options.resolve !== false) await config.resolve(contributions);

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
      authorities: () => AuthorityCatalog.from([...CORE_AUTHORITIES]),
      config,
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

/** What is actually on disk, which is the only copy there is. */
async function onDisk(directory: string, name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(directory, name), 'utf8')) as Record<string, unknown>;
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

describe('reading configuration', () => {
  test('enumerates every section with the shape of write it accepts', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config`, { headers: nox.headers });
    const body = (await response.json()) as {
      sections: { entries: boolean; key: string; loaded: boolean; writable: boolean }[];
    };
    const section = (key: string) => body.sections.find((entry) => entry.key === key);

    expect(response.status).toBe(200);
    expect(body.sections.map((entry) => entry.key)).toEqual([
      'app',
      'blueprints',
      'brokers',
      'providers',
      'toolSets',
    ]);

    // A directory is readable here and administered elsewhere; a contributed
    // section and a directory are both addressed one entry at a time.
    expect(section('blueprints')).toMatchObject({ entries: true, writable: false });
    expect(section('providers')).toMatchObject({ entries: true, loaded: true, writable: true });
    expect(section('app')).toMatchObject({ entries: false, writable: true });
  });

  test('describes the tools exposed by configured capability instances', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/capabilities/tool-sets`, { headers: nox.headers });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      toolSets: [
        {
          available: true,
          description: 'Tools that exist only in this test.',
          id: 'internet',
          name: 'Fake tools',
          tools: [
            {
              authority: 'test.extension.fake_read',
              description: 'fake_read test capability.',
              name: 'fake_read',
            },
            {
              authority: 'test.extension.fake_write',
              description: 'fake_write test capability.',
              name: 'fake_write',
            },
          ],
          type: 'fake_tools',
        },
      ],
    });
  });

  test('reads one section back with the defaults its schema resolved', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/app`, { headers: nox.headers });
    const body = (await response.json()) as { name: string; value: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.name).toBe('app.json');
    expect(body.value).toMatchObject({ database: { path: 'nox.db' }, logLevel: 'info' });
  });

  test('reads a directory section it will not write', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/blueprints`, { headers: nox.headers });
    const body = (await response.json()) as { value: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(Object.keys(body.value)).toEqual(['nox']);
  });

  test('answers 404 for a section nothing defines', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/nonsense`, { headers: nox.headers });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'section_not_found' });
  });

  test('answers 503 for a section the extensions have not reached yet', async () => {
    const nox = await configNox({ resolve: false });

    const response = await fetch(`${nox.url}/config/providers`, { headers: nox.headers });

    // Not 404: the section exists and has no value, which is a different thing
    // from a section that does not exist, and a different thing to do about it.
    expect(response.status).toBe(503);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: 'section_unresolved',
    });
  });

  test('says nothing at all without a token', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config`);

    expect(response.status).toBe(401);
  });
});

describe('writing a whole section', () => {
  test('replaces the document and says the change waits for a restart', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/app`, {
      body: JSON.stringify({ logLevel: 'debug' }),
      headers: nox.headers,
      method: 'PUT',
    });
    const body = (await response.json()) as {
      restartRequired: boolean;
      value: { logLevel: string };
    };

    expect(response.status).toBe(200);
    expect(body.restartRequired).toBeTrue();
    expect(body.value.logLevel).toBe('debug');
    expect(await onDisk(nox.directory, 'app.json')).toMatchObject({ logLevel: 'debug' });
    expect(nox.config.get('app').logLevel).toBe('debug');
  });

  test('refuses a web-chat default that cannot compose on restart', async () => {
    const nox = await configNox({
      blueprints: {
        nox: NOX,
        spare: { ...NOX, systemPrompt: 'be spare' },
      },
    });

    const missing = await fetch(`${nox.url}/config/app`, {
      body: JSON.stringify({ logLevel: 'debug' }),
      headers: nox.headers,
      method: 'PUT',
    });
    expect(missing.status).toBe(422);
    expect((await missing.json()) as { problems: string[] }).toMatchObject({
      problems: ['chat.defaultAgent is required when 2 agents are configured'],
    });

    const unknown = await fetch(`${nox.url}/config/app`, {
      body: JSON.stringify({ chat: { defaultAgent: 'ghost' } }),
      headers: nox.headers,
      method: 'PUT',
    });
    expect(unknown.status).toBe(422);
    expect((await unknown.json()) as { problems: string[] }).toMatchObject({
      problems: ['chat.defaultAgent names "ghost", but blueprints configures no such agent'],
    });

    const valid = await fetch(`${nox.url}/config/app`, {
      body: JSON.stringify({ chat: { defaultAgent: 'spare' } }),
      headers: nox.headers,
      method: 'PUT',
    });
    expect(valid.status).toBe(200);
    expect(await onDisk(nox.directory, 'app.json')).toMatchObject({
      chat: { defaultAgent: 'spare' },
    });
  });

  test('refuses a document its schema rejects, leaving the file alone', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/app`, {
      body: JSON.stringify({ logLevel: 'chatty' }),
      headers: nox.headers,
      method: 'PUT',
    });

    expect(response.status).toBe(422);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'invalid_config' });
    expect(await onDisk(nox.directory, 'app.json')).toMatchObject({ logLevel: 'info' });
  });

  test('refuses keys no setting matches rather than dropping them', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/app`, {
      body: JSON.stringify({ logLevel: 'info', logLevelTypo: 'debug' }),
      headers: nox.headers,
      method: 'PUT',
    });

    expect(response.status).toBe(422);
    expect((await response.json()) as { detail: string }).toMatchObject({
      error: 'invalid_config',
    });
  });

  test('refuses to write a directory section whole', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/blueprints`, {
      body: JSON.stringify({ nox: NOX }),
      headers: nox.headers,
      method: 'PUT',
    });

    // The blueprints have their own surface, with the judgement a generic
    // section write has no way to pass.
    expect(response.status).toBe(409);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: 'section_not_writable',
    });
  });
});

describe('writing one entry', () => {
  test('creates one without disturbing the instances already in the file', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/providers/spare`, {
      body: JSON.stringify({ baseUrl: 'https://spare.test', type: 'fake_provider' }),
      headers: nox.headers,
      method: 'POST',
    });
    const body = (await response.json()) as { entryId: string; restartRequired: boolean };

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ entryId: 'spare', restartRequired: true });

    // The whole point of an instance route: one file, and the other instance
    // survived the write untouched.
    expect(await onDisk(nox.directory, 'providers.json')).toMatchObject({
      main: { baseUrl: 'https://main.test' },
      spare: { baseUrl: 'https://spare.test' },
    });
  });

  test('refuses a create that would replace an existing instance', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/providers/main`, {
      body: JSON.stringify(PROVIDER),
      headers: nox.headers,
      method: 'POST',
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'entry_exists' });
  });

  test('replaces one whole', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/providers/main`, {
      body: JSON.stringify({ baseUrl: 'https://moved.test', type: 'fake_provider' }),
      headers: nox.headers,
      method: 'PUT',
    });

    expect(response.status).toBe(200);
    expect(await onDisk(nox.directory, 'providers.json')).toMatchObject({
      main: { baseUrl: 'https://moved.test' },
    });
  });

  test('refuses a replace of an instance nothing configures', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/providers/ghost`, {
      body: JSON.stringify(PROVIDER),
      headers: nox.headers,
      method: 'PUT',
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'entry_not_found' });
  });

  test('refuses an instance whose kind no extension registered', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/providers/spare`, {
      body: JSON.stringify({ baseUrl: 'https://spare.test', type: 'no_such_kind' }),
      headers: nox.headers,
      method: 'POST',
    });

    expect(response.status).toBe(422);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'invalid_config' });
    expect(Object.keys(await onDisk(nox.directory, 'providers.json'))).toEqual(['main']);
  });

  test('refuses broker routes and grants that gateway composition cannot resolve', async () => {
    const nox = await configNox();

    const unknownAgent = await fetch(`${nox.url}/config/brokers/discord`, {
      body: JSON.stringify({ agent: 'ghost', type: 'fake_broker' }),
      headers: nox.headers,
      method: 'POST',
    });
    expect(unknownAgent.status).toBe(422);
    expect((await unknownAgent.json()) as { problems: string[] }).toMatchObject({
      problems: ['blueprints configures no base agent "ghost"'],
    });

    const unknownAuthority = await fetch(`${nox.url}/config/brokers/discord`, {
      body: JSON.stringify({
        agent: 'nox',
        grants: { esteban: ['nox.unknown'] },
        type: 'fake_broker',
      }),
      headers: nox.headers,
      method: 'POST',
    });
    expect(unknownAuthority.status).toBe(422);
    expect((await unknownAuthority.json()) as { problems: string[] }).toMatchObject({
      problems: [expect.stringContaining('nox.unknown')],
    });
    expect(await onDisk(nox.directory, 'brokers.json')).toEqual({});
  });

  test('accepts unresolved dormant routes on a disabled broker', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/brokers/discord`, {
      body: JSON.stringify({ agent: 'ghost', enabled: false, type: 'fake_broker' }),
      headers: nox.headers,
      method: 'POST',
    });

    expect(response.status).toBe(201);
    expect(await onDisk(nox.directory, 'brokers.json')).toMatchObject({
      discord: { agent: 'ghost', enabled: false },
    });
  });

  test('has no instances to address in a section holding one document', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/app/logLevel`, {
      body: JSON.stringify({ value: 'debug' }),
      headers: nox.headers,
      method: 'PUT',
    });

    expect(response.status).toBe(409);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: 'section_has_no_entries',
    });
  });
});

describe('removing one entry', () => {
  test('removes one nothing names', async () => {
    const nox = await configNox();
    await fetch(`${nox.url}/config/toolSets/spare`, {
      body: JSON.stringify({ type: 'fake_tools' }),
      headers: nox.headers,
      method: 'POST',
    });

    const response = await fetch(`${nox.url}/config/toolSets/spare`, {
      headers: nox.headers,
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
    expect(Object.keys(await onDisk(nox.directory, 'toolsets.json'))).toEqual(['internet']);
  });

  test('refuses to remove a provider a blueprint still names', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/providers/main`, {
      headers: nox.headers,
      method: 'DELETE',
    });
    const body = (await response.json()) as { error: string; reasons: string[] };

    // Bootstrap fails on a blueprint naming a provider nothing configures. The
    // operator finds out here, not at a restart days later.
    expect(response.status).toBe(409);
    expect(body.error).toBe('entry_in_use');
    expect(body.reasons).toEqual(['blueprints/nox.json names it.']);
    expect(Object.keys(await onDisk(nox.directory, 'providers.json'))).toEqual(['main']);
  });

  test('refuses to remove a tool set a blueprint still grants', async () => {
    const nox = await configNox({
      blueprints: { nox: { ...NOX, toolSets: { direct: [{ id: 'internet', tools: ['fetch'] }] } } },
    });

    const response = await fetch(`${nox.url}/config/toolSets/internet`, {
      headers: nox.headers,
      method: 'DELETE',
    });
    const body = (await response.json()) as { reasons: string[] };

    // Named through the object form of a grant, which is the form a reference
    // check reading only strings would have missed.
    expect(response.status).toBe(409);
    expect(body.reasons).toEqual(['blueprints/nox.json names it.']);
  });

  test('refuses to remove an agent an enabled broker still routes to', async () => {
    const nox = await configNox({
      blueprints: {
        nox: NOX,
        spare: { ...NOX, systemPrompt: 'be spare' },
      },
      brokers: {
        discord: { agent: 'nox', type: 'fake_broker' },
      },
    });

    const response = await fetch(`${nox.url}/config/blueprints/nox`, {
      headers: nox.headers,
      method: 'DELETE',
    });
    const body = (await response.json()) as { reasons: string[] };

    expect(response.status).toBe(409);
    expect(body.reasons).toEqual(['brokers.json entry "discord" names it as its base agent.']);
  });

  test('answers 404 for an instance nothing configures', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/providers/ghost`, {
      headers: nox.headers,
      method: 'DELETE',
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'entry_not_found' });
  });
});
