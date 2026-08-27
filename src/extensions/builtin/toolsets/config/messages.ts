const englishMessages = Object.freeze({
  'toolSet.description':
    'Inspect and administer Nox configuration, runtime generations, and secret metadata.',
  'toolSet.name': 'Configuration',
  'tools.config_create.description': 'Create a new configuration entry without replacing one.',
  'tools.config_delete.description': 'Delete a configuration entry when nothing still needs it.',
  'tools.config_get.description': 'Read the app document or one named configuration entry.',
  'tools.config_list.description': 'List IDs in an entry-based configuration section.',
  'tools.config_reload.description': 'Reload permitted mounted configuration sections.',
  'tools.config_replace.description': 'Replace one existing configuration entry whole.',
  'tools.config_retry.description': 'Retry desired runtime configuration activation.',
  'tools.config_revert.description': 'Restore the document before the latest failed activation.',
  'tools.config_schema.description': 'Read authoritative configuration schemas.',
  'tools.config_secrets.description': 'List secret metadata without returning secret values.',
  'tools.config_status.description': 'Read configuration and runtime generation status.',
  'tools.config_toolsets.description': 'Inspect tools exposed by configured tool sets.',
  'tools.config_update_app.description': 'Replace the complete application configuration document.',
  'ui.manageRuntime': 'Manage runtime activation',
  'ui.manageRuntimeHelp': 'Expose reload, retry, and failed-change revert tools.',
  'ui.readSecretMetadata': 'Read secret metadata',
  'ui.readSecretMetadataHelp':
    'Expose secret IDs, storage state, references, and consumers; values are never readable.',
  'ui.readSections': 'Readable sections',
  'ui.readSectionsHelp': 'Comma-separated configuration sections the read tools may inspect.',
  'ui.writeSections': 'Writable sections',
  'ui.writeSectionsHelp': 'Comma-separated configuration sections the mutation tools may change.',
} as const);

export { englishMessages };
