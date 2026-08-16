export class PluginError extends Error {
  public constructor(
    message: string,
    public readonly pluginId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class PluginManifestError extends PluginError {}

export class DuplicatePluginError extends PluginError {
  public constructor(pluginId: string) {
    super(`Plugin "${pluginId}" is already registered.`, pluginId);
  }
}

export class UnknownPluginError extends PluginError {
  public constructor(pluginId: string) {
    super(`Plugin "${pluginId}" is not registered.`, pluginId);
  }
}

export class PluginCompatibilityError extends PluginError {}

export class MissingPluginDependencyError extends PluginError {
  public constructor(pluginId: string, public readonly dependencyId: string) {
    super(`Plugin "${pluginId}" requires missing plugin "${dependencyId}".`, pluginId);
  }
}

export class PluginDependencyVersionError extends PluginError {
  public constructor(
    pluginId: string,
    public readonly dependencyId: string,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      `Plugin "${pluginId}" requires "${dependencyId}" ${expected}, but ${actual} is installed.`,
      pluginId,
    );
  }
}

export class CircularPluginDependencyError extends PluginError {
  public constructor(public readonly path: readonly string[]) {
    super(`Circular plugin dependency: ${path.join(" -> ")}.`, path[0]);
  }
}

export class PluginActivationError extends PluginError {
  public constructor(pluginId: string, cause: unknown) {
    super(`Plugin "${pluginId}" failed to activate.`, pluginId, { cause });
  }
}

export class PluginDeactivationError extends PluginError {
  public constructor(pluginId: string, cause: unknown) {
    super(`Plugin "${pluginId}" failed to deactivate cleanly.`, pluginId, { cause });
  }
}

export class DuplicateContributionError extends PluginError {
  public constructor(
    pluginId: string,
    public readonly extensionPointId: string,
    public readonly contributionId: string,
  ) {
    super(
      `Contribution "${contributionId}" already exists at extension point "${extensionPointId}".`,
      pluginId,
    );
  }
}

export class DuplicateServiceError extends Error {
  public constructor(public readonly serviceId: string) {
    super(`Service "${serviceId}" is already registered.`);
    this.name = new.target.name;
  }
}

export class MissingServiceError extends Error {
  public constructor(public readonly serviceId: string) {
    super(`Required service "${serviceId}" is not available.`);
    this.name = new.target.name;
  }
}
