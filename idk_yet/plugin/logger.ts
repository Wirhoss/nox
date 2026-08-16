export type LogMetadata = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, metadata?: LogMetadata): void;
  info(message: string, metadata?: LogMetadata): void;
  warn(message: string, metadata?: LogMetadata): void;
  error(message: string, metadata?: LogMetadata): void;
}

export const noopLogger: Logger = Object.freeze({
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
});

export function prefixLogger(logger: Logger, prefix: string): Logger {
  const format = (message: string): string => `[${prefix}] ${message}`;

  return {
    debug: (message, metadata) => logger.debug(format(message), metadata),
    info: (message, metadata) => logger.info(format(message), metadata),
    warn: (message, metadata) => logger.warn(format(message), metadata),
    error: (message, metadata) => logger.error(format(message), metadata),
  };
}
