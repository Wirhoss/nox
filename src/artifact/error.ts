class ArtifactNotFoundError extends Error {
  public readonly artifactId: string;

  constructor(artifactId: string) {
    super(`Artifact "${artifactId}" does not exist or is outside this scope.`);
    this.name = 'ArtifactNotFoundError';
    this.artifactId = artifactId;
  }
}

class ArtifactTooLargeError extends Error {
  public readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`Artifact exceeds the ${String(maxBytes)} byte ingestion limit.`);
    this.name = 'ArtifactTooLargeError';
    this.maxBytes = maxBytes;
  }
}

class ArtifactRepresentationUnavailableError extends Error {
  public readonly artifactId: string;
  public readonly profileId: string;

  constructor(artifactId: string, profileId: string, mediaType: string) {
    super(
      `Artifact "${artifactId}" (${mediaType}) has no representation for profile "${profileId}".`,
    );
    this.name = 'ArtifactRepresentationUnavailableError';
    this.artifactId = artifactId;
    this.profileId = profileId;
  }
}

class ArtifactProcessorOutputError extends Error {
  public readonly processorId: string;

  constructor(processorId: string, message: string, options?: ErrorOptions) {
    super(`Artifact processor "${processorId}" ${message}`, options);
    this.name = 'ArtifactProcessorOutputError';
    this.processorId = processorId;
  }
}

class ArtifactProcessorDeterminismError extends Error {
  public readonly processorId: string;

  constructor(processorId: string, version: string) {
    super(
      `Artifact processor "${processorId}" version "${version}" produced conflicting output ` +
        'for an existing deterministic cache key.',
    );
    this.name = 'ArtifactProcessorDeterminismError';
    this.processorId = processorId;
  }
}

export {
  ArtifactNotFoundError,
  ArtifactProcessorDeterminismError,
  ArtifactProcessorOutputError,
  ArtifactRepresentationUnavailableError,
  ArtifactTooLargeError,
};
