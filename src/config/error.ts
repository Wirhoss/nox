type ConfigErrorCode =
  'invalid_json' | 'invalid_schema' | 'unknown_keys' | 'unreadable' | 'unresolved' | 'unwritable';

/** A configuration failure that always names the file or directory it came from. */
class ConfigError extends Error {
  public readonly code: ConfigErrorCode;
  public readonly path: string;

  constructor(code: ConfigErrorCode, path: string, message: string, cause?: unknown) {
    super(`${path}: ${message}`, { cause });
    this.name = 'ConfigError';
    this.code = code;
    this.path = path;
  }
}

function isConfigError(error: unknown): error is ConfigError {
  return error instanceof ConfigError;
}

export { ConfigError, isConfigError };

export type { ConfigErrorCode };
