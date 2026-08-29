import {
  type ConfigEntryKey,
  type ConfigKey,
  type ConfigurationAdmin,
  entryIdSchema,
  type MessageContent,
  type SecretMetadataReader,
  stableStringify,
  type Tool,
  type ToolContext,
  type ToolRisk,
  z,
} from '@nox/extension-api';

import { configSectionKeySchema, type ConfigToolSetPolicy } from './model';

const CONFIG_READ_AUTHORITY = 'nox.toolset.config.read';
const CONFIG_RUNTIME_AUTHORITY = 'nox.toolset.config.runtime';
const CONFIG_WRITE_AUTHORITY = 'nox.toolset.config.write';

const ENTRY_SECTION_KEYS = Object.freeze([
  'blueprints',
  'brokers',
  'memories',
  'providers',
  'toolSets',
] as const satisfies readonly ConfigEntryKey[]);
const entrySectionKeySchema = z.enum(ENTRY_SECTION_KEYS);
const configValueSchema = z.record(z.string(), z.unknown());

function text(value: unknown): MessageContent[] {
  return [{ text: stableStringify(value), type: 'text' }];
}

function run<T>(ctx: ToolContext, operation: () => Promise<T> | T): Promise<MessageContent[]> {
  ctx.abortSignal.throwIfAborted();
  return Promise.resolve(operation()).then((value) => text(value));
}

function requireRead(policy: ConfigToolSetPolicy, section: ConfigKey): void {
  if (!policy.readSections.has(section)) {
    throw new Error(`This config tool-set instance does not permit reading section "${section}".`);
  }
}

function requireWrite(policy: ConfigToolSetPolicy, section: ConfigKey): void {
  if (!policy.writeSections.has(section)) {
    throw new Error(`This config tool-set instance does not permit writing section "${section}".`);
  }
}

function resource(section: ConfigKey, entryId?: string) {
  return {
    kind: 'command' as const,
    value: `config:${section}${entryId === undefined ? '' : `/${entryId}`}`,
  };
}

function mutationRisk(
  section: ConfigKey,
  entryId: string | undefined,
  effect: 'delete' | 'write',
): ToolRisk {
  return {
    effects: effect === 'delete' ? ['delete', 'privilege', 'write'] : ['privilege', 'write'],
    resources: [resource(section, entryId)],
    reversible: effect !== 'delete',
  };
}

function visibleSections(policy: ConfigToolSetPolicy): ReadonlySet<ConfigKey> {
  return new Set([...policy.readSections, ...policy.writeSections]);
}

function componentSection(
  kind: ReturnType<ConfigurationAdmin['runtimeStatuses']>[number]['kind'],
): ConfigKey {
  switch (kind) {
    case 'agent':
      return 'blueprints';
    case 'application':
      return 'app';
    case 'broker':
      return 'brokers';
    case 'memory':
      return 'memories';
    case 'provider':
      return 'providers';
    case 'toolSet':
      return 'toolSets';
  }
}

function runtimeSnapshot(admin: ConfigurationAdmin, policy: ConfigToolSetPolicy) {
  const visible = visibleSections(policy);
  return {
    components: admin
      .runtimeStatuses()
      .filter((component) => visible.has(componentSection(component.kind))),
    revertAvailable: policy.manageRuntime && admin.revertAvailable,
    ...(policy.manageRuntime && admin.revertTarget !== undefined
      ? { revertTarget: admin.revertTarget }
      : {}),
  };
}

function entrySummaries(value: unknown): readonly Record<string, unknown>[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([entryId, entry]) => ({
      entryId,
      ...(typeof entry === 'object' &&
      entry !== null &&
      !Array.isArray(entry) &&
      typeof (entry as Record<string, unknown>).type === 'string'
        ? { type: (entry as Record<string, unknown>).type }
        : {}),
    }));
}

function configTools(
  admin: ConfigurationAdmin,
  secrets: SecretMetadataReader,
  policy: ConfigToolSetPolicy,
): readonly Tool[] {
  const tools: Tool[] = [];

  if (policy.readSections.size > 0 || policy.manageRuntime) {
    const parameters = z.object({});
    const status: Tool<typeof parameters> = {
      authority: CONFIG_READ_AUTHORITY,
      description:
        'List permitted configuration sections and current runtime generation states, including the pending revert target.',
      name: 'config_status',
      parameters,
      prepare: () => ({
        run: (ctx) =>
          run(ctx, () => {
            const visible = visibleSections(policy);
            return {
              ...runtimeSnapshot(admin, policy),
              sections: admin.sections().filter((section) => visible.has(section.key)),
            };
          }),
        title: 'Inspect configuration status',
        type: 'immediate',
      }),
      risk: { effects: ['read'], reversible: true },
    };
    tools.push(status);
  }

  if (policy.readSections.size > 0) {
    const schemaParameters = z.object({
      section: configSectionKeySchema.describe('Configuration section.'),
      type: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe('Optional contribution type discriminator to select from a contributed section.'),
    });
    const schema: Tool<typeof schemaParameters> = {
      authority: CONFIG_READ_AUTHORITY,
      description:
        'Return the authoritative JSON Schema for a section or one contributed provider, memory, broker, or tool-set type.',
      name: 'config_schema',
      parameters: schemaParameters,
      prepare: ({ section, type }) => ({
        run: (ctx) =>
          run(ctx, () => {
            requireRead(policy, section);
            const descriptor = admin.schema(section);
            if (type === undefined) return descriptor;
            const selected = descriptor.types?.find((candidate) => candidate.type === type);
            if (selected === undefined) {
              throw new Error(`Section "${section}" has no contributed type "${type}".`);
            }
            return { ...descriptor, types: [selected] };
          }),
        title: `Read configuration schema — ${section}${type === undefined ? '' : `/${type}`}`,
        type: 'immediate',
      }),
      risk: { effects: ['read'], reversible: true },
    };

    const listParameters = z.object({
      section: entrySectionKeySchema.describe('Entry-based configuration section.'),
    });
    const list: Tool<typeof listParameters> = {
      authority: CONFIG_READ_AUTHORITY,
      description:
        'List entry IDs and contribution types in an entry-based configuration section without returning every full document.',
      name: 'config_list',
      parameters: listParameters,
      prepare: ({ section }) => ({
        run: (ctx) =>
          run(ctx, () => {
            requireRead(policy, section);
            const entries = entrySummaries(admin.read(section));
            return { count: entries.length, entries, section };
          }),
        title: `List configuration entries — ${section}`,
        type: 'immediate',
      }),
      risk: { effects: ['read'], reversible: true },
    };

    const getParameters = z.object({
      entryId: entryIdSchema
        .optional()
        .describe('Required for entry-based sections; omit only when reading app.'),
      section: configSectionKeySchema.describe('Configuration section.'),
    });
    const get: Tool<typeof getParameters> = {
      authority: CONFIG_READ_AUTHORITY,
      description:
        'Read the complete app document or one named agent, broker, provider, or tool-set entry. Secret references contain IDs, never values.',
      name: 'config_get',
      parameters: getParameters,
      prepare: ({ entryId, section }) => ({
        run: (ctx) =>
          run(ctx, () => {
            requireRead(policy, section);
            if (section === 'app') {
              if (entryId !== undefined) throw new Error('Section "app" has no named entries.');
              return { section, value: admin.read(section) };
            }
            if (entryId === undefined) {
              throw new Error(`Section "${section}" requires an entryId. Use config_list first.`);
            }
            const value = admin.readEntry(section, entryId);
            if (value === undefined) {
              throw new Error(`Entry "${entryId}" does not exist in section "${section}".`);
            }
            return { entryId, section, value };
          }),
        title: `Read configuration — ${section}${entryId === undefined ? '' : `/${entryId}`}`,
        type: 'immediate',
      }),
      risk: { effects: ['read'], reversible: true },
    };

    tools.push(schema, list, get);

    if (policy.readSections.has('toolSets')) {
      const inventoryParameters = z.object({});
      const inventory: Tool<typeof inventoryParameters> = {
        authority: CONFIG_READ_AUTHORITY,
        description:
          'Describe every configured tool-set instance and the exact tools and authorities its active candidate exposes.',
        name: 'config_toolsets',
        parameters: inventoryParameters,
        prepare: () => ({
          run: (ctx) => run(ctx, async () => ({ toolSets: await admin.toolSetInventory() })),
          title: 'Inspect configured tool sets',
          type: 'immediate',
        }),
        risk: { effects: ['read'], reversible: true },
      };
      tools.push(inventory);
    }
  }

  if (policy.readSecretMetadata) {
    const parameters = z.object({});
    const secretMetadata: Tool<typeof parameters> = {
      authority: CONFIG_READ_AUTHORITY,
      description:
        'List managed secret IDs, storage state, references, and runtime consumers. Secret values are never returned.',
      name: 'config_secrets',
      parameters,
      prepare: () => ({
        run: (ctx) =>
          run(ctx, async () => ({
            secrets: (await secrets.list()).map((secret) => ({
              ...secret,
              consumers: secrets.consumers(secret.secretId),
            })),
          })),
        title: 'Inspect managed secret metadata',
        type: 'immediate',
      }),
      risk: { effects: ['read'], reversible: true },
    };
    tools.push(secretMetadata);
  }

  if (policy.writeSections.has('app')) {
    const parameters = z.object({
      value: configValueSchema.describe('Complete replacement app document.'),
    });
    const updateApp: Tool<typeof parameters> = {
      authority: CONFIG_WRITE_AUTHORITY,
      description:
        'Replace app.json as one complete document. Infrastructure changes may require restart; omitted keys are not merged back.',
      name: 'config_update_app',
      parameters,
      prepare: ({ value }) => ({
        preview: stableStringify(value),
        risk: mutationRisk('app', undefined, 'write'),
        run: (ctx) =>
          run(ctx, async () => {
            requireWrite(policy, 'app');
            const saved = await admin.write('app', value);
            return { ...runtimeSnapshot(admin, policy), section: 'app', ...saved };
          }),
        title: 'Replace application configuration',
        type: 'immediate',
      }),
      risk: { effects: ['privilege', 'write'], reversible: true },
    };
    tools.push(updateApp);
  }

  if (policy.writeSections.size > (policy.writeSections.has('app') ? 1 : 0)) {
    const createParameters = z.object({
      entryId: entryIdSchema.describe('New entry ID.'),
      section: entrySectionKeySchema.describe('Entry-based configuration section.'),
      value: configValueSchema.describe('Complete new entry document.'),
    });
    const create: Tool<typeof createParameters> = {
      authority: CONFIG_WRITE_AUTHORITY,
      description:
        'Create one new agent, broker, provider, or tool-set entry; refuses to replace an existing ID.',
      name: 'config_create',
      parameters: createParameters,
      prepare: ({ entryId, section, value }) => ({
        preview: stableStringify(value),
        risk: mutationRisk(section, entryId, 'write'),
        run: (ctx) =>
          run(ctx, async () => {
            requireWrite(policy, section);
            if (admin.readEntry(section, entryId) !== undefined) {
              throw new Error(`Entry "${entryId}" already exists in section "${section}".`);
            }
            const saved = await admin.writeEntry(section, entryId, value);
            return { ...runtimeSnapshot(admin, policy), entryId, section, ...saved };
          }),
        title: `Create configuration entry — ${section}/${entryId}`,
        type: 'immediate',
      }),
      risk: { effects: ['privilege', 'write'], reversible: true },
    };

    const replaceParameters = z.object({
      entryId: entryIdSchema.describe('Existing entry ID.'),
      section: entrySectionKeySchema.describe('Entry-based configuration section.'),
      value: configValueSchema.describe('Complete replacement entry document.'),
    });
    const replace: Tool<typeof replaceParameters> = {
      authority: CONFIG_WRITE_AUTHORITY,
      description:
        'Replace one existing agent, broker, provider, or tool-set entry as a complete document; refuses to create a missing ID.',
      name: 'config_replace',
      parameters: replaceParameters,
      prepare: ({ entryId, section, value }) => ({
        preview: stableStringify(value),
        risk: mutationRisk(section, entryId, 'write'),
        run: (ctx) =>
          run(ctx, async () => {
            requireWrite(policy, section);
            if (admin.readEntry(section, entryId) === undefined) {
              throw new Error(`Entry "${entryId}" does not exist in section "${section}".`);
            }
            const saved = await admin.writeEntry(section, entryId, value);
            return { ...runtimeSnapshot(admin, policy), entryId, section, ...saved };
          }),
        title: `Replace configuration entry — ${section}/${entryId}`,
        type: 'immediate',
      }),
      risk: { effects: ['privilege', 'write'], reversible: true },
    };

    const deleteParameters = z.object({
      entryId: entryIdSchema.describe('Existing entry ID.'),
      section: entrySectionKeySchema.describe('Entry-based configuration section.'),
    });
    const remove: Tool<typeof deleteParameters> = {
      authority: CONFIG_WRITE_AUTHORITY,
      description:
        'Delete one agent, broker, provider, or tool-set entry. References and reserved control-plane entries can block removal.',
      name: 'config_delete',
      parameters: deleteParameters,
      prepare: ({ entryId, section }) => ({
        risk: mutationRisk(section, entryId, 'delete'),
        run: (ctx) =>
          run(ctx, async () => {
            requireWrite(policy, section);
            if (admin.readEntry(section, entryId) === undefined) {
              throw new Error(`Entry "${entryId}" does not exist in section "${section}".`);
            }
            const deleted = await admin.removeEntry(section, entryId);
            return { ...runtimeSnapshot(admin, policy), deleted, entryId, section };
          }),
        title: `Delete configuration entry — ${section}/${entryId}`,
        type: 'immediate',
      }),
      risk: { effects: ['delete', 'privilege', 'write'], reversible: false },
    };

    tools.push(create, replace, remove);
  }

  if (policy.manageRuntime) {
    const parameters = z.object({});
    const reload: Tool<typeof parameters> = {
      authority: CONFIG_RUNTIME_AUTHORITY,
      description:
        'Reload mounted files only for sections this tool-set instance may write, preserving each last valid document independently.',
      name: 'config_reload',
      parameters,
      prepare: () => ({
        risk: {
          effects: ['execute', 'privilege', 'write'],
          resources: [...policy.writeSections].map((section) => resource(section)),
          reversible: false,
          volume: policy.writeSections.size,
        },
        run: (ctx) =>
          run(ctx, async () => {
            await admin.reloadConfiguration([...policy.writeSections]);
            return runtimeSnapshot(admin, policy);
          }),
        title: 'Reload mounted configuration',
        type: 'immediate',
      }),
      risk: { effects: ['execute', 'privilege', 'write'], reversible: false },
    };

    const retry: Tool<typeof parameters> = {
      authority: CONFIG_RUNTIME_AUTHORITY,
      description:
        'Retry activation of all desired runtime configuration while retaining each last working generation on failure.',
      name: 'config_retry',
      parameters,
      prepare: () => ({
        risk: {
          effects: ['execute', 'privilege'],
          resources: [{ kind: 'command', value: 'config:runtime/retry' }],
          reversible: false,
        },
        run: (ctx) =>
          run(ctx, async () => {
            await admin.retryRuntime();
            return runtimeSnapshot(admin, policy);
          }),
        title: 'Retry runtime configuration activation',
        type: 'immediate',
      }),
      risk: { effects: ['execute', 'privilege'], reversible: false },
    };

    const revert: Tool<typeof parameters> = {
      authority: CONFIG_RUNTIME_AUTHORITY,
      description:
        'Restore the desired document preceding the latest failed activation, only when its section is writable by this instance.',
      name: 'config_revert',
      parameters,
      prepare: () => ({
        risk: {
          effects: ['privilege', 'write'],
          resources: [{ kind: 'command', value: 'config:runtime/revert' }],
          reversible: false,
        },
        run: (ctx) =>
          run(ctx, async () => {
            const target = admin.revertTarget;
            if (target === undefined)
              throw new Error('No failed configuration change can be reverted.');
            requireWrite(policy, target.key);
            await admin.revertRuntime(target.key);
            return runtimeSnapshot(admin, policy);
          }),
        title: 'Revert failed configuration change',
        type: 'immediate',
      }),
      risk: { effects: ['privilege', 'write'], reversible: false },
    };

    tools.push(reload, retry, revert);
  }

  return Object.freeze(tools);
}

export { CONFIG_READ_AUTHORITY, CONFIG_RUNTIME_AUTHORITY, CONFIG_WRITE_AUTHORITY, configTools };
