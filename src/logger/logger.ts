type LogLevel = 'debug' | 'error' | 'info' | 'trace' | 'warn';

type LogFields = Readonly<Record<string, unknown>>;

interface LoggerOptions {
  level?: LogLevel;
  write?: (line: string) => void;
}

interface Logger {
  child(name: string): Logger;
  debug(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;
  info(fields: LogFields, message: string): void;
  trace(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
}

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

const LEVEL_LABEL: Readonly<Record<LogLevel, string>> = {
  trace: 'TRC',
  debug: 'DBG',
  info: 'INF',
  warn: 'WRN',
  error: 'ERR',
};

const NEEDS_QUOTING = /[\s"=]/;

function writeToStderr(line: string): void {
  process.stderr.write(line);
}

function formatTime(at: Date): string {
  const hours = String(at.getHours()).padStart(2, '0');
  const minutes = String(at.getMinutes()).padStart(2, '0');
  const seconds = String(at.getSeconds()).padStart(2, '0');
  const millis = String(at.getMilliseconds()).padStart(3, '0');
  return `${hours}:${minutes}:${seconds}.${millis}`;
}

function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  if (value instanceof Error) return formatValue(`${value.name}: ${value.message}`);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `[${value.map((item) => formatValue(item)).join(',')}]`;

  if (typeof value === 'string') {
    return NEEDS_QUOTING.test(value) ? JSON.stringify(value) : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  if (typeof value === 'function' || typeof value === 'symbol') return `<${typeof value}>`;
  try {
    return JSON.stringify(value);
  } catch {
    return '<unserializable>';
  }
}

function formatFields(fields: LogFields): string {
  const entries = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return '';
  return ` ${entries.map(([key, value]) => `${key}=${formatValue(value)}`).join(' ')}`;
}

class ConsoleLogger implements Logger {
  readonly #level: LogLevel;
  readonly #module: string;
  readonly #write: (line: string) => void;

  constructor(module: string, options: LoggerOptions = {}) {
    this.#module = module;
    this.#level = options.level ?? 'info';
    this.#write = options.write ?? writeToStderr;
  }

  public child(name: string): Logger {
    return new ConsoleLogger(`${this.#module}:${name}`, {
      level: this.#level,
      write: this.#write,
    });
  }

  public debug(fields: LogFields, message: string): void {
    this.log('debug', fields, message);
  }

  public error(fields: LogFields, message: string): void {
    this.log('error', fields, message);
  }

  public info(fields: LogFields, message: string): void {
    this.log('info', fields, message);
  }

  public trace(fields: LogFields, message: string): void {
    this.log('trace', fields, message);
  }

  public warn(fields: LogFields, message: string): void {
    this.log('warn', fields, message);
  }

  private log(level: LogLevel, fields: LogFields, message: string): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.#level]) return;

    const time = formatTime(new Date());
    const single = message.replace(/\s+/gu, ' ').trim();
    this.#write(`${time} ${LEVEL_LABEL[level]} ${this.#module} ${single}${formatFields(fields)}\n`);
  }
}

const silentLogger: Logger = {
  child: (): Logger => silentLogger,
  debug: (): void => undefined,
  error: (): void => undefined,
  info: (): void => undefined,
  trace: (): void => undefined,
  warn: (): void => undefined,
};

function createLogger(module: string, options: LoggerOptions = {}): Logger {
  return new ConsoleLogger(module, options);
}

export { createLogger, silentLogger };

export type { LogFields, Logger, LoggerOptions, LogLevel };
