import { describe, expect, test } from 'bun:test';

import { ConfigToolSet } from './configToolSet';

import type {
  ConfigEntryKey,
  ConfigKey,
  ConfigRevertTarget,
  ConfigSectionSchemaDescriptor,
  ConfigSectionSummary,
  ConfigurationAdmin,
  ProviderInventory,
  RuntimeComponentStatus,
  SecretMetadataReader,
  ToolExecution,
} from '@nox/extension-api';

const SECTION_KEYS = ['app', 'blueprints', 'brokers', 'memories', 'providers', 'toolSets'] as const;

class RecordingAdmin implements ConfigurationAdmin {
  public readonly entries: Record<ConfigEntryKey, Record<string, unknown>> = {
    blueprints: { nox: { model: 'main', provider: 'main', systemPrompt: 'Be exact.' } },
    brokers: {},
    memories: {},
    providers: { main: { baseUrl: 'https://models.example/v1', type: 'openai_completions' } },
    toolSets: {},
  };
  public app: unknown = { logLevel: 'info', timezone: 'UTC' };
  public reloaded?: readonly ConfigKey[];
  public providerInventoryRefreshes = 0;
  public retries = 0;
  public reverted = 0;
  public revertTarget?: ConfigRevertTarget;

  public get revertAvailable(): boolean {
    return this.revertTarget !== undefined;
  }

  public providerInventory(refresh = false): Promise<readonly ProviderInventory[]> {
    this.providerInventoryRefreshes += refresh ? 1 : 0;
    return Promise.resolve([
      {
        available: true,
        id: 'main',
        kinds: ['chat'],
        models: [
          { configured: true, kind: 'chat', modelId: 'declared-model' },
          { configured: false, modelId: 'reported-model' },
        ],
        reported: true,
        type: 'openai_completions',
      },
    ]);
  }

  public read(key: ConfigKey): unknown {
    return key === 'app' ? this.app : this.entries[key];
  }

  public readEntry(key: ConfigEntryKey, entryId: string): unknown {
    return this.entries[key][entryId];
  }

  public reloadConfiguration(keys?: readonly ConfigKey[]): Promise<void> {
    this.reloaded = keys;
    return Promise.resolve();
  }

  public removeEntry(key: ConfigEntryKey, entryId: string): Promise<boolean> {
    if (!(entryId in this.entries[key])) return Promise.resolve(false);
    Reflect.deleteProperty(this.entries[key], entryId);
    return Promise.resolve(true);
  }

  public retryRuntime(): Promise<void> {
    this.retries += 1;
    return Promise.resolve();
  }

  public revertRuntime(expectedKey?: ConfigKey): Promise<void> {
    if (expectedKey !== this.revertTarget?.key) throw new Error('wrong revert target');
    this.reverted += 1;
    this.revertTarget = undefined;
    return Promise.resolve();
  }

  public runtimeStatuses(): readonly RuntimeComponentStatus[] {
    return [
      {
        activeGeneration: 1,
        desiredGeneration: 2,
        id: 'main',
        kind: 'provider',
        state: 'active',
      },
    ];
  }

  public schema(key: ConfigKey): ConfigSectionSchemaDescriptor {
    if (key === 'providers') {
      return {
        applies: 'hot',
        key,
        kind: 'contribution',
        types: [
          {
            extensionId: 'nox.provider.openai',
            instances: 'many',
            schema: { properties: { type: { const: 'openai_completions' } }, type: 'object' },
            type: 'openai_completions',
          },
        ],
      };
    }
    return { applies: key === 'app' ? 'restart' : 'hot', key, kind: 'directory', schema: {} };
  }

  public sections(): readonly ConfigSectionSummary[] {
    return SECTION_KEYS.map((key) => ({
      applies: key === 'app' ? 'restart' : 'hot',
      creatable: key === 'blueprints' || key === 'providers',
      description: `settings.sections.${key}.description`,
      editor: 'json',
      entries: key !== 'app',
      group: 'machine',
      key,
      kind: key === 'app' ? 'file' : key === 'blueprints' ? 'directory' : 'contribution',
      label: `settings.sections.${key}.label`,
      loaded: true,
      name: key === 'app' ? 'app.json' : key,
      plural: `settings.sections.${key}.plural`,
      references: [],
      slug: key,
      writable: key !== 'blueprints',
    }));
  }

  public toolSetInventory(): Promise<readonly []> {
    return Promise.resolve([]);
  }

  public write(key: ConfigKey, next: unknown) {
    if (key !== 'app') throw new Error('Only app is a whole document.');
    this.app = next;
    return Promise.resolve({ restartRequired: true, value: next });
  }

  public writeEntry(key: ConfigEntryKey, entryId: string, next: unknown) {
    this.entries[key][entryId] = next;
    return Promise.resolve({ restartRequired: false, value: next });
  }
}

const secretMetadata: SecretMetadataReader = {
  consumers: (secretId) =>
    secretId === 'OPENAI_API_KEY'
      ? [{ extensionId: 'nox.provider.openai', location: 'providers.main.apiKey' }]
      : [],
  list: () =>
    Promise.resolve([
      {
        references: [{ location: 'providers.main.apiKey', secretId: 'OPENAI_API_KEY' }],
        secretId: 'OPENAI_API_KEY',
        stored: true,
      },
    ]),
};

async function result(execution: ToolExecution): Promise<Record<string, unknown>> {
  const content = await execution.run({ abortSignal: new AbortController().signal });
  const settled = 'ack' in content ? await content.result : content;
  const first = settled[0];
  if (first?.type !== 'text') throw new Error('Expected a text tool result.');
  return JSON.parse(first.text) as Record<string, unknown>;
}

describe('ConfigToolSet', () => {
  test('exposes complete administration by default and cuts tools with instance policy', () => {
    const all = new ConfigToolSet({ type: 'config' }, new RecordingAdmin(), secretMetadata);
    expect(Object.keys(all.tools)).toEqual([
      'config_create',
      'config_delete',
      'config_get',
      'config_list',
      'config_providers',
      'config_reload',
      'config_replace',
      'config_retry',
      'config_revert',
      'config_schema',
      'config_secrets',
      'config_status',
      'config_toolsets',
      'config_update_app',
    ]);

    const reader = new ConfigToolSet(
      {
        manageRuntime: false,
        readSecretMetadata: false,
        readSections: ['blueprints'],
        type: 'config',
        writeSections: [],
      },
      new RecordingAdmin(),
      secretMetadata,
    );
    expect(Object.keys(reader.tools)).toEqual([
      'config_get',
      'config_list',
      'config_schema',
      'config_status',
    ]);
    expect(
      () =>
        new ConfigToolSet(
          {
            manageRuntime: false,
            readSecretMetadata: false,
            readSections: [],
            type: 'config',
            writeSections: [],
          },
          new RecordingAdmin(),
          secretMetadata,
        ),
    ).toThrow('Enable at least one');
  });

  test('reads schemas, entries, runtime status, and secret metadata without secret values', async () => {
    const toolSet = new ConfigToolSet({ type: 'config' }, new RecordingAdmin(), secretMetadata);

    expect(await result(toolSet.prepare('config_schema', { section: 'providers' }))).toMatchObject({
      key: 'providers',
      types: [{ extensionId: 'nox.provider.openai', type: 'openai_completions' }],
    });
    expect(await result(toolSet.prepare('config_list', { section: 'providers' }))).toEqual({
      count: 1,
      entries: [{ entryId: 'main', type: 'openai_completions' }],
      section: 'providers',
    });
    expect(
      await result(toolSet.prepare('config_get', { entryId: 'main', section: 'providers' })),
    ).toMatchObject({ entryId: 'main', section: 'providers' });
    expect(await result(toolSet.prepare('config_status', {}))).toMatchObject({
      components: [{ id: 'main', kind: 'provider' }],
      revertAvailable: false,
    });

    const secrets = await result(toolSet.prepare('config_secrets', {}));
    expect(secrets).toMatchObject({
      secrets: [
        {
          consumers: [{ extensionId: 'nox.provider.openai' }],
          secretId: 'OPENAI_API_KEY',
          stored: true,
        },
      ],
    });
    expect(JSON.stringify(secrets)).not.toContain('secret-value');
  });

  test('names the models a provider serves so an agent does not have to guess one', async () => {
    const admin = new RecordingAdmin();
    const toolSet = new ConfigToolSet({ type: 'config' }, admin, secretMetadata);

    expect(await result(toolSet.prepare('config_providers', {}))).toEqual({
      providers: [
        {
          available: true,
          id: 'main',
          kinds: ['chat'],
          models: [
            { configured: true, kind: 'chat', modelId: 'declared-model' },
            { configured: false, modelId: 'reported-model' },
          ],
          reported: true,
          type: 'openai_completions',
        },
      ],
    });
    expect(admin.providerInventoryRefreshes).toBe(0);

    await result(toolSet.prepare('config_providers', { refresh: true }));
    expect(admin.providerInventoryRefreshes).toBe(1);
  });

  test('creates, replaces, and deletes entries with privilege-aware risk', async () => {
    const admin = new RecordingAdmin();
    const toolSet = new ConfigToolSet({ type: 'config' }, admin, secretMetadata);
    const createdValue = {
      description: 'Worker',
      model: 'm',
      provider: 'main',
      systemPrompt: 'Work.',
    };

    const create = toolSet.prepare('config_create', {
      entryId: 'worker',
      section: 'blueprints',
      value: createdValue,
    });
    expect(create.risk?.effects).toEqual(['privilege', 'write']);
    expect(create.risk?.resources).toEqual([
      { kind: 'command', value: 'config:blueprints/worker' },
    ]);
    expect(await result(create)).toMatchObject({ entryId: 'worker', restartRequired: false });
    expect(admin.entries.blueprints.worker).toEqual(createdValue);

    const replacement = { ...createdValue, description: 'Updated worker' };
    await result(
      toolSet.prepare('config_replace', {
        entryId: 'worker',
        section: 'blueprints',
        value: replacement,
      }),
    );
    expect(admin.entries.blueprints.worker).toEqual(replacement);

    const remove = toolSet.prepare('config_delete', {
      entryId: 'worker',
      section: 'blueprints',
    });
    expect(remove.risk).toMatchObject({ reversible: false });
    expect(await result(remove)).toMatchObject({ deleted: true, entryId: 'worker' });
    expect(admin.entries.blueprints.worker).toBeUndefined();
  });

  test('scopes mounted reload and failed-change revert to writable sections', async () => {
    const admin = new RecordingAdmin();
    admin.revertTarget = { entryId: 'main', key: 'providers' };
    const toolSet = new ConfigToolSet(
      {
        readSections: ['providers'],
        type: 'config',
        writeSections: ['providers'],
      },
      admin,
      secretMetadata,
    );

    await result(toolSet.prepare('config_reload', {}));
    expect(admin.reloaded).toEqual(['providers']);
    expect(
      result(
        toolSet.prepare('config_create', {
          entryId: 'worker',
          section: 'blueprints',
          value: { model: 'm', provider: 'main', systemPrompt: 'Work.' },
        }),
      ),
    ).rejects.toThrow('does not permit writing section "blueprints"');
    await result(toolSet.prepare('config_retry', {}));
    expect(admin.retries).toBe(1);
    await result(toolSet.prepare('config_revert', {}));
    expect(admin.reverted).toBe(1);
  });
});
