import pino from 'pino';
import pretty from 'pino-pretty';

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

const logger: Logger = process.env.NODE_ENV !== 'production'
  ? pino({ level: process.env.LOG_LEVEL ?? 'info' }, prettyStream)
  : pino({ level: process.env.LOG_LEVEL ?? 'info' });

export const createLogger = (module: string): Logger => logger.child({ module });

export default logger;
