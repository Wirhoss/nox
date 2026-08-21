import { bootstrap } from './bootstrap';
import { loggerService } from './services';

import type { Session } from './agent/session';
import type { NoxApplication } from './application';
import type { Logger } from './logger/logger';

/** Yields complete lines, so a message split across chunks arrives whole. */
async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? '';
    for (const part of parts) yield part;
  }

  buffer += decoder.decode();
  if (buffer.length > 0) yield buffer;
}

/** Streams the model's reply to stdout; the logger owns stderr. */
async function printReplies(session: Session, logger: Logger): Promise<void> {
  for await (const event of session.events) {
    switch (event.type) {
      case 'assistantTextFragment': {
        process.stdout.write(event.text);
        break;
      }
      case 'error': {
        logger.error({ err: event.error }, 'Session reported an error.');
        break;
      }
      case 'retry': {
        logger.warn(
          { attempt: event.attempt, delayMs: event.delayMs },
          'Provider request is being retried.',
        );
        break;
      }
      case 'assistantReasoningFragment':
      case 'message':
      case 'permissionRequested':
      case 'permissionResolved':
      case 'runCompleted':
      case 'runStarted':
      case 'usage': {
        // The transcript, the run boundaries and the token counts already reach
        // storage and the log. Stdout carries the conversation and nothing else.
        break;
      }
    }
  }
}

/**
 * Which agent this terminal talks to. The choice belongs to the surface, not to
 * the installation: another surface attached to the same Nox answers it its own
 * way. With a single blueprint there is nothing to choose.
 */
function agentFor(application: NoxApplication): string {
  const named = process.env.NOX_AGENT_ID;
  const agentIds = application.agentIds;

  if (named !== undefined && named.length > 0) {
    if (!agentIds.includes(named)) {
      throw new Error(
        `NOX_AGENT_ID is "${named}"; no blueprint defines it. Defined: ${agentIds.join(', ')}.`,
      );
    }
    return named;
  }

  const only = agentIds[0];
  if (agentIds.length !== 1 || only === undefined) {
    throw new Error(`Set NOX_AGENT_ID to one of: ${agentIds.join(', ')}.`);
  }
  return only;
}

/** One terminal attached to one session. A surface, not the application. */
async function run(): Promise<void> {
  const application = await bootstrap();
  const agentId = agentFor(application);
  const logger = application.services.get(loggerService);
  const session = await application.openSession(agentId, {
    sessionId: process.env.NOX_SESSION_ID,
  });
  const printing = printReplies(session, logger);

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    // The session first so its event log closes and the printer can finish;
    // the application then releases everything bootstrap opened.
    await application.closeSession(session.sessionId);
    await printing;
    await application.stop();
  };

  process.on('SIGINT', () => {
    void stop().then(() => {
      process.exit(0);
    });
  });

  process.stdout.write(`nox · session ${session.sessionId} · /exit to quit\n\n> `);

  for await (const line of readLines(Bun.stdin.stream())) {
    const text = line.trim();
    if (text === '/exit') break;
    if (text.length === 0) {
      process.stdout.write('> ');
      continue;
    }

    session.send(text);
    await session.idle;
    process.stdout.write('\n\n> ');
  }

  await stop();
}

export { run };
