import { ToolSet } from '@nox/extension-api';

import { configToolSetConfigSchema } from './model';
import { configTools } from './tools';

import type { ConfigToolSetConfig, ConfigToolSetConfigInput, ConfigToolSetPolicy } from './model';
import type { ConfigurationAdmin, SecretMetadataReader } from '@nox/extension-api';

/**
 * Administrative access to Nox's desired configuration through the same host
 * boundary as Settings. The configured instance scopes sections; authorities
 * and the Gate still decide whether the principal may perform each concrete call.
 */
class ConfigToolSet extends ToolSet {
  static readonly configSchema = configToolSetConfigSchema;

  readonly #admin: ConfigurationAdmin;
  readonly #config: ConfigToolSetConfig;
  readonly #secrets: SecretMetadataReader;

  constructor(
    input: ConfigToolSetConfigInput,
    admin: ConfigurationAdmin,
    secrets: SecretMetadataReader,
  ) {
    const config = configToolSetConfigSchema.parse(input);
    super(
      'Configuration',
      'Inspect and administer Nox configuration, runtime generations, and secret metadata.',
      config.enabledTools,
    );
    this.#admin = admin;
    this.#config = config;
    this.#secrets = secrets;
    this.addTools();
  }

  protected override addTools(): void {
    const policy: ConfigToolSetPolicy = {
      manageRuntime: this.#config.manageRuntime,
      readSecretMetadata: this.#config.readSecretMetadata,
      readSections: new Set(this.#config.readSections),
      writeSections: new Set(this.#config.writeSections),
    };
    for (const tool of configTools(this.#admin, this.#secrets, policy)) this.registerTool(tool);
  }
}

export { ConfigToolSet, configToolSetConfigSchema };

export type { ConfigToolSetConfig, ConfigToolSetConfigInput };
