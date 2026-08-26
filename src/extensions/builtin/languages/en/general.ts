const generalMessages = Object.freeze({
  'settings.general.access': 'ACCESS',
  'settings.general.accessTtl': 'Access token TTL (seconds)',
  'settings.general.accessTtlHint': '60–3600 seconds. Default: 900.',
  'settings.general.applicationJson': 'Application JSON',
  'settings.general.applicationJsonHelp':
    'Full document access using the same schema as app.json. Saving replaces the document whole; defaults are materialized by Nox.',
  'settings.general.artifactSizeLimit': 'Maximum artifact bytes',
  'settings.general.artifactSizeLimitHint':
    'Largest original or generated rendition accepted by the streaming store.',
  'settings.general.artifactStorageQuota': 'Artifact storage quota (bytes)',
  'settings.general.artifactStorageQuotaHint':
    'Total unique immutable bytes retained across originals and cached renditions.',
  'settings.general.automaticAgent': 'Automatic · {agent}',
  'settings.general.bindHost': 'Bind host',
  'settings.general.bindHostHint':
    'Use 127.0.0.1 for local-only access or 0.0.0.0 for every interface.',
  'settings.general.busyTimeout': 'Busy timeout (ms)',
  'settings.general.busyTimeoutHint': 'How long SQLite waits for a competing writer.',
  'settings.general.changeRefused': 'Application change refused',
  'settings.general.configuredAgents.one': '{count} configured Agent.',
  'settings.general.configuredAgents.other': '{count} configured Agents.',
  'settings.general.controlPlane': 'CONTROL PLANE',
  'settings.general.dataPlane': 'DATA PLANE',
  'settings.general.databasePath': 'Database path',
  'settings.general.databasePathHint':
    'Absolute path or a path relative to the configured data directory.',
  'settings.general.diagnostics': 'DIAGNOSTICS',
  'settings.general.durability.extra': 'Extra',
  'settings.general.durability.full': 'Full',
  'settings.general.durability.normal': 'Normal',
  'settings.general.durability.off': 'Off',
  'settings.general.durabilityHint': 'Normal balances WAL durability and write throughput.',
  'settings.general.durabilityMode': 'Durability mode',
  'settings.general.httpListener': 'HTTP listener',
  'settings.general.httpListenerHelp':
    'Interface and port serving the authenticated API and this workbench. A wrong boundary can make the node unreachable after restart.',
  'settings.general.httpPort': 'HTTP port',
  'settings.general.httpPortHint': '0 asks the operating system for an ephemeral port.',
  'settings.general.httpsRequired': 'HTTPS boundary required',
  'settings.general.httpsRequiredHelp':
    'Browsers will not return the refresh cookie over plain HTTP. Enable this only when the public Nox endpoint is protected by TLS.',
  'settings.general.interface': 'INTERFACE',
  'settings.general.interfaceLanguage': 'Interface language',
  'settings.general.interfaceLanguageHelp':
    'Default language for this installation. The public access screen can keep a browser-specific choice.',
  'settings.general.locale': 'Default language',
  'settings.general.localeHint':
    'Applied immediately in this browser and as the installation default.',
  'settings.general.logLevel': 'Log level',
  'settings.general.machineControl': 'MACHINE CONTROL // APPLICATION',
  'settings.general.refreshTtl': 'Refresh session TTL (seconds)',
  'settings.general.refreshTtlHint': '3600–31536000 seconds. Default: 30 days.',
  'settings.general.runtimeLogging': 'Runtime logging',
  'settings.general.runtimeLoggingHelp':
    'Minimum event severity written by Nox. Trace and debug can expose operational metadata and produce substantially more output.',
  'settings.general.save': 'Save general settings',
  'settings.general.timezone': 'Time zone',
  'settings.general.timezoneHint':
    'IANA zone, such as UTC or America/Mexico_City. Agents read every message timestamp in it.',
  'settings.general.saved': 'Application configuration saved',
  'settings.general.secureCookies': 'Secure refresh cookies',
  'settings.general.secureCookiesHelp': 'Send the refresh cookie only over HTTPS.',
  'settings.general.sessionSecurity': 'Session security',
  'settings.general.sessionSecurityHelp':
    'Short-lived access tokens authorize requests; the refresh session keeps an operator signed in and remains revocable.',
  'settings.general.sqliteStorage': 'Persistent storage',
  'settings.general.sqliteStorageHelp':
    'SQLite state, artifact limits, lock contention and durability. Relative paths resolve inside the Nox data directory.',
  'settings.general.validation.artifactStorageQuota':
    'Storage quota must be at least the maximum artifact size.',
  'settings.general.validation.configurationObject':
    'Application configuration must be one JSON object.',
  'settings.general.validation.durabilityMode': 'Choose a supported SQLite durability mode.',
  'settings.general.validation.hostRequired': 'A bind host is required.',
  'settings.general.validation.locale': 'Choose an installed language.',
  'settings.general.validation.timezone':
    'Use an IANA time zone name, such as UTC or America/Mexico_City.',
  'settings.general.validation.logLevel': 'Choose a supported log level.',
  'settings.general.validation.pathRequired': 'A database path is required.',
  'settings.general.webChat': 'WEB CHAT',
} as const);

export { generalMessages };
