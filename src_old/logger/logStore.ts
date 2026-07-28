import { Writable } from 'node:stream';

const PINO_LEVELS = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
} as const;

type LogLevel = typeof PINO_LEVELS[keyof typeof PINO_LEVELS];

type LogEntry = {
  context: Record<string, unknown>;
  id: number;
  level: LogLevel;
  message: string;
  module: string | null;
  timestamp: string;
};

type LogQuery = {
  level?: LogLevel;
  limit?: number;
  module?: string;
  offset?: number;
  search?: string;
};

type LogQueryResult = {
  dropped: number;
  items: LogEntry[];
  modules: string[];
  total: number;
};

const RESERVED_FIELDS = new Set(['hostname', 'level', 'module', 'msg', 'pid', 'time']);

class StructuredLogStore extends Writable {
  private readonly capacity: number;
  private dropped = 0;
  private entries: LogEntry[] = [];
  private malformed = 0;
  private nextId = 1;
  private pending = '';

  constructor(capacity = 1_000) {
    super();
    this.capacity = capacity;
  }

  public list(query: LogQuery = {}): LogQueryResult {
    const { level, limit = 200, module, offset = 0, search } = query;
    const needle = search?.trim().toLowerCase();
    const filtered = this.entries.filter((entry) => {
      if (level !== undefined && entry.level !== level) return false;
      if (module !== undefined && entry.module !== module) return false;
      if (!needle) return true;
      return entry.message.toLowerCase().includes(needle)
        || (entry.module?.toLowerCase().includes(needle) ?? false)
        || JSON.stringify(entry.context).toLowerCase().includes(needle);
    });

    return {
      dropped: this.dropped,
      items: filtered.slice().reverse().slice(offset, offset + limit),
      modules: [...new Set(this.entries.flatMap((entry) => entry.module === null ? [] : [entry.module]))].sort(),
      total: filtered.length,
    };
  }

  public ingest(record: Record<string, unknown>): void {
    const numericLevel = typeof record['level'] === 'number' ? record['level'] : 30;
    const level = PINO_LEVELS[numericLevel as keyof typeof PINO_LEVELS] ?? 'info';
    const rawTime = record['time'];
    const date = new Date(typeof rawTime === 'number' || typeof rawTime === 'string' ? rawTime : Date.now());
    const context = Object.fromEntries(
      Object.entries(record).filter(([key]) => !RESERVED_FIELDS.has(key)),
    );
    this.entries.push({
      context,
      id: this.nextId++,
      level,
      message: typeof record['msg'] === 'string' ? record['msg'] : '',
      module: typeof record['module'] === 'string' ? record['module'] : null,
      timestamp: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
    });
    if (this.entries.length > this.capacity) {
      const removeCount = this.entries.length - this.capacity;
      this.entries.splice(0, removeCount);
      this.dropped += removeCount;
    }
  }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.pending += chunk.toString();
    const lines = this.pending.split('\n');
    this.pending = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.ingest(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // The console destination remains authoritative if a malformed record
        // ever reaches this secondary observability stream. Reporting through
        // the logger would recurse back into this stream, so note it on stderr
        // instead of dropping it without a trace.
        this.malformed += 1;
        process.stderr.write(`[logStore] Dropped a malformed log record (${this.malformed} so far).\n`);
      }
    }
    callback();
  }
}

export {
  StructuredLogStore,
};

export type {
  LogEntry,
  LogLevel,
  LogQuery,
  LogQueryResult,
};
