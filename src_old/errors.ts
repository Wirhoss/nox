class NotFoundError extends Error {
  public readonly code = 'not_found';
  public readonly status = 404;
}

class ConflictError extends Error {
  public readonly code = 'conflict';
  public readonly status = 409;
}

class ServiceUnavailableError extends Error {
  public readonly code = 'service_unavailable';
  public readonly status = 503;
}

type DomainError = NotFoundError | ConflictError | ServiceUnavailableError;

function isDomainError(error: unknown): error is DomainError {
  return error instanceof NotFoundError
    || error instanceof ConflictError
    || error instanceof ServiceUnavailableError;
}

export {
  ConflictError,
  isDomainError,
  NotFoundError,
  ServiceUnavailableError,
};

export type {
  DomainError,
};
