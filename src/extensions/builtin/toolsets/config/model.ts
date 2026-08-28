import { type ConfigKey, toolSetBaseConfigSchema, z } from '@nox/extension-api';

const CONFIG_SECTION_KEYS = Object.freeze([
  'app',
  'blueprints',
  'brokers',
  'memories',
  'providers',
  'toolSets',
] as const satisfies readonly ConfigKey[]);

const configSectionKeySchema = z.enum(CONFIG_SECTION_KEYS);

const configToolSetConfigSchema = toolSetBaseConfigSchema
  .extend({
    manageRuntime: z
      .boolean()
      .default(true)
      .meta({ nox: { help: 'ui.manageRuntimeHelp', label: 'ui.manageRuntime' } }),
    readSecretMetadata: z
      .boolean()
      .default(true)
      .meta({ nox: { help: 'ui.readSecretMetadataHelp', label: 'ui.readSecretMetadata' } }),
    readSections: z
      .array(configSectionKeySchema)
      .default([...CONFIG_SECTION_KEYS])
      .meta({ nox: { help: 'ui.readSectionsHelp', label: 'ui.readSections' } }),
    type: z.literal('config'),
    writeSections: z
      .array(configSectionKeySchema)
      .default([...CONFIG_SECTION_KEYS])
      .meta({ nox: { help: 'ui.writeSectionsHelp', label: 'ui.writeSections' } }),
  })
  .superRefine((config, context) => {
    if (
      config.readSections.length === 0 &&
      config.writeSections.length === 0 &&
      !config.manageRuntime &&
      !config.readSecretMetadata
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Enable at least one configuration administration capability.',
      });
    }
  });

type ConfigToolSetConfig = z.infer<typeof configToolSetConfigSchema>;
type ConfigToolSetConfigInput = z.input<typeof configToolSetConfigSchema>;

interface ConfigToolSetPolicy {
  readonly manageRuntime: boolean;
  readonly readSecretMetadata: boolean;
  readonly readSections: ReadonlySet<ConfigKey>;
  readonly writeSections: ReadonlySet<ConfigKey>;
}

export { CONFIG_SECTION_KEYS, configSectionKeySchema, configToolSetConfigSchema };

export type { ConfigToolSetConfig, ConfigToolSetConfigInput, ConfigToolSetPolicy };
