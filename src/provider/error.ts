type ProviderErrorCode =
  | 'authentication'
  | 'connection'
  | 'context_limit'
  | 'invalid_request'
  | 'provider_error'
  | 'rate_limit'
  | 'usage_limit';

interface ProviderErrorOptions {
  cause?: unknown;
  provider?: string;
  providerCode?: string;
  status?: number;
}

class ProviderError extends Error {
  public readonly code: ProviderErrorCode;
  public readonly provider?: string;
  public readonly providerCode?: string;
  public readonly status?: number;

  constructor(code: ProviderErrorCode, message: string, options: ProviderErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'ProviderError';
    this.code = code;
    this.provider = options.provider;
    this.providerCode = options.providerCode;
    this.status = options.status;
  }
}

function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

function toProviderError(
  error: unknown,
  fallbackMessage = 'Provider request failed',
): ProviderError {
  if (isProviderError(error)) return error;

  let message = fallbackMessage;
  if (error instanceof Error) message = error.message;
  else if (typeof error === 'string' && error.length > 0) message = error;

  return new ProviderError('provider_error', message, { cause: error });
}

export { isProviderError, ProviderError, toProviderError };

export type { ProviderErrorCode, ProviderErrorOptions };
