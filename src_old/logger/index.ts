import pino from 'pino';
import pretty from 'pino-pretty';

import { StructuredLogStore } from './logStore';

import type { Logger } from 'pino';

const LEVEL_BADGES: Record<string, string> = {
  trace: '·',
  debug: '◌',
  info: '●',
  warn: '▲',
  error: '✖',
  fatal: '✺',
};

const LEVEL_LABEL_WIDTH = 5;

const prettyStream = pretty({
  colorize: true,
  sync: true,
  translateTime: 'SYS:HH:MM:ss.l',
  ignore: 'pid,hostname,module',
  errorLikeObjectKeys: ['err', 'error'],
  errorProps: '*',
  customColors: 'message:reset',
  useOnlyCustomProps: false,
  messageFormat: (log, messageKey, _levelLabel, { colors }) => {
    const msg = String(log[messageKey] ?? '');
    const module = log.module
      ? `${colors.cyan(String(log.module))} ${colors.dim('›')} `
      : '';
    return `${module}${msg}`;
  },
  customPrettifiers: {
    time: (timestamp) => `\x1b[2m${String(timestamp)}\x1b[22m`,
    level: (_level, _key, _log, { label, labelColorized }) => {
      const badge = LEVEL_BADGES[label.toLowerCase()] ?? '●';
      const padding = ' '.repeat(Math.max(0, LEVEL_LABEL_WIDTH - label.length));
      return `${labelColorized.replace(label, `${badge} ${label}`)}${padding}`;
    },
  },
});

/**
 * Credentials live one careless `logger.info({ config })` away from the log
 * store, which the UI serves over HTTP. Redaction is cheap insurance: it is
 * applied before either stream sees the record.
 */
const REDACTED_PATHS = [
  'apiKey',
  '*.apiKey',
  '*.*.apiKey',
  'headers.authorization',
  '*.headers.authorization',
];

const logLevel = process.env.LOG_LEVEL ?? 'info';
const logStore = new StructuredLogStore();
const consoleStream = process.env.NODE_ENV !== 'production' ? prettyStream : process.stdout;
const logger: Logger = pino(
  {
    level: logLevel,
    redact: { censor: '[redacted]', paths: REDACTED_PATHS },
  },
  pino.multistream([
    { level: logLevel, stream: consoleStream },
    { level: logLevel, stream: logStore },
  ]),
);

export const createLogger = (module: string): Logger => logger.child({ module });

export {
  logStore,
};

export type { LogEntry, LogLevel, LogQueryResult } from './logStore';

export default logger;
