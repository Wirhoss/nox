type DatabaseErrorCode =
  | 'connection_failed'
  | 'migration_failed'
  | 'not_initialized'
  | 'unknown_store';

class DatabaseError extends Error {
  public readonly code: DatabaseErrorCode;

  constructor(code: DatabaseErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'DatabaseError';
    this.code = code;
  }
}

class NotInitializedError extends DatabaseError {
  constructor(action: string) {
    super(
      'not_initialized',
      `Cannot ${action}: database not initialized. Call init() before using the database.`,
    );
    this.name = 'NotInitializedError';
  }
}

class ConnectionFailedError extends DatabaseError {
  public readonly target: string;

  constructor(target: string, cause?: unknown) {
    super('connection_failed', `Failed to open database at ${target}.`, cause);
    this.name = 'ConnectionFailedError';
    this.target = target;
  }
}

class MigrationFailedError extends DatabaseError {
  public readonly target: string;

  constructor(target: string, cause?: unknown) {
    super(
      'migration_failed',
      `Migrations failed for ${target}; the schema is in an unknown state.`,
      cause,
    );
    this.name = 'MigrationFailedError';
    this.target = target;
  }
}

class UnknownStoreError extends DatabaseError {
  public readonly storeName: string;

  constructor(storeName: string, known: readonly string[]) {
    super(
      'unknown_store',
      `Store "${storeName}" is not registered. Known stores: ${known.join(', ') || '(none)'}.`,
    );
    this.name = 'UnknownStoreError';
    this.storeName = storeName;
  }
}

function isDatabaseError(error: unknown): error is DatabaseError {
  return error instanceof DatabaseError;
}

export {
  ConnectionFailedError,
  DatabaseError,
  isDatabaseError,
  MigrationFailedError,
  NotInitializedError,
  UnknownStoreError,
};

export type {
  DatabaseErrorCode,
};
