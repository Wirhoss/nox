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

export { ArtifactNotFoundError, ArtifactTooLargeError };
