type ExtensionErrorCode =
  | 'activation_failed'
  | 'duplicate_contribution'
  | 'duplicate_extension'
  | 'duplicate_service'
  | 'incompatible'
  | 'missing_service';

class ExtensionError extends Error {
  public readonly code: ExtensionErrorCode;
  public readonly extensionId?: string;

  constructor(code: ExtensionErrorCode, message: string, extensionId?: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'ExtensionError';
    this.code = code;
    this.extensionId = extensionId;
  }
}

class DuplicateExtensionError extends ExtensionError {
  constructor(extensionId: string) {
    super('duplicate_extension', `Extension "${extensionId}" is already registered.`, extensionId);
    this.name = 'DuplicateExtensionError';
  }
}

class ExtensionActivationError extends ExtensionError {
  constructor(extensionId: string, cause: unknown) {
    super(
      'activation_failed',
      `Extension "${extensionId}" failed to activate.`,
      extensionId,
      cause,
    );
    this.name = 'ExtensionActivationError';
  }
}

class ExtensionCompatibilityError extends ExtensionError {
  public readonly noxVersion: string;
  public readonly required: string;

  constructor(extensionId: string, required: string, noxVersion: string) {
    super(
      'incompatible',
      `Extension "${extensionId}" requires Nox ${required}, but this runtime is ${noxVersion}.`,
      extensionId,
    );
    this.name = 'ExtensionCompatibilityError';
    this.noxVersion = noxVersion;
    this.required = required;
  }
}

class DuplicateContributionError extends ExtensionError {
  public readonly contributionId: string;
  public readonly contributionPointId: string;

  constructor(extensionId: string, contributionPointId: string, contributionId: string) {
    super(
      'duplicate_contribution',
      `Contribution "${contributionId}" already exists at contribution point "${contributionPointId}".`,
      extensionId,
    );
    this.name = 'DuplicateContributionError';
    this.contributionId = contributionId;
    this.contributionPointId = contributionPointId;
  }
}

class DuplicateServiceError extends ExtensionError {
  public readonly serviceId: string;

  constructor(serviceId: string) {
    super('duplicate_service', `Service "${serviceId}" is already registered.`);
    this.name = 'DuplicateServiceError';
    this.serviceId = serviceId;
  }
}

class MissingServiceError extends ExtensionError {
  public readonly serviceId: string;

  constructor(serviceId: string) {
    super('missing_service', `Required service "${serviceId}" is not available.`);
    this.name = 'MissingServiceError';
    this.serviceId = serviceId;
  }
}

function isExtensionError(error: unknown): error is ExtensionError {
  return error instanceof ExtensionError;
}

export {
  DuplicateContributionError,
  DuplicateExtensionError,
  DuplicateServiceError,
  ExtensionActivationError,
  ExtensionCompatibilityError,
  ExtensionError,
  isExtensionError,
  MissingServiceError,
};

export type { ExtensionErrorCode };
