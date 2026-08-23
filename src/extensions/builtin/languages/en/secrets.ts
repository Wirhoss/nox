const secretMessages = Object.freeze({
  'settings.secrets.awaitingValue': 'awaiting a value',
  'settings.secrets.blankHint':
    'The field is intentionally blank even when a value already exists.',
  'settings.secrets.configuredReferences': 'CONFIGURED REFERENCES',
  'settings.secrets.configuredReferencesHelp':
    'Every configured entry naming this ID. One value serves all of them, which is what reusing a credential across entries looks like.',
  'settings.secrets.consumers': 'CONSUMERS',
  'settings.secrets.created': 'CREATED',
  'settings.secrets.delete': 'Delete secret',
  'settings.secrets.deleteQuestion': 'Delete managed secret?',
  'settings.secrets.deleteWarning':
    'The value cannot be recovered. Running consumers may retain their current snapshot, but the next restart will fail if configuration still references this ID.',
  'settings.secrets.id': 'Secret ID',
  'settings.secrets.idHint': 'Stable reference used in configuration, for example OPENAI_API_KEY.',
  'settings.secrets.managed': 'SECURITY // MANAGED SECRETS',
  'settings.secrets.new': 'New secret',
  'settings.secrets.newValue': 'New value',
  'settings.secrets.noRunningConsumer': 'No running contribution has resolved this secret.',
  'settings.secrets.noneKnown': 'No known secrets',
  'settings.secrets.noneKnownHelp':
    'No configuration names a credential and none has been stored. Store one here, then reference its ID from a provider, tool set or broker entry.',
  'settings.secrets.notSet': 'NOT SET',
  'settings.secrets.notStored': 'NOT STORED',
  'settings.secrets.operationRefused': 'Secret operation refused',
  'settings.secrets.originMany': 'used by {count} configured entries',
  'settings.secrets.originOne': 'used by {location}',
  'settings.secrets.originUnreferenced': 'stored, referenced by nothing',
  'settings.secrets.referencesRemain.one':
    'The ID stays listed as unset afterwards: {count} configured entry still names it.',
  'settings.secrets.referencesRemain.other':
    'The ID stays listed as unset afterwards: {count} configured entries still name it.',
  'settings.secrets.replaceCredential': 'Replace credential',
  'settings.secrets.replaceValue': 'Replace value',
  'settings.secrets.runtimeReferences': 'RUNTIME REFERENCES',
  'settings.secrets.runtimeReferencesHelp':
    'Consumers already holding a handle keep their snapshot until restart.',
  'settings.secrets.store': 'Store secret',
  'settings.secrets.storeCredential': 'Store credential',
  'settings.secrets.storeStatus': 'STORE STATUS',
  'settings.secrets.stored': 'STORED',
  'settings.secrets.storedRestart':
    'One or more running consumers retain the previous value until Nox restarts.',
  'settings.secrets.storedTitle': 'Secret stored',
  'settings.secrets.updated': 'UPDATED',
  'settings.secrets.updatedAt': 'updated {date}',
  'settings.secrets.usedBy': 'Used by',
  'settings.secrets.valueAccepted': 'The value was accepted.',
  'settings.secrets.valuePlaceholder': 'Value will not be shown again',
  'settings.secrets.valueRequired': 'A secret value cannot be empty.',
  'settings.secrets.writeOnly': 'WRITE-ONLY VALUE',
  'settings.secrets.writeOnlyHelp':
    'Nox encrypts this value at rest. The browser can write it but no API can retrieve it again.',
} as const);

export { secretMessages };
