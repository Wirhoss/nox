import { createSocket } from 'node:dgram';
import { readFileSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

/**
 * An extension body that tries to leave.
 *
 * Every one of these is something an ordinary package can do today, in the
 * process that also holds Nox's database and secret key. They are loaded into a
 * confined child by `scripts/probe-confinement.ts`, which expects all of them
 * to be denied — so this file is the statement of what the boundary is for,
 * written as code that runs rather than as a list.
 */

function outcome(cause: unknown): string {
  const code: unknown = (cause as { code?: unknown }).code;
  if (typeof code === 'string') return code;
  return cause instanceof Error ? cause.name : String(cause);
}

export default {
  /** Proves the channel itself works, so a denial below means denial and not a broken child. */
  echo: (value: unknown): unknown => value,

  readPathSync: (path: string): string => {
    try {
      readFileSync(path);
      return 'allowed';
    } catch (cause) {
      return outcome(cause);
    }
  },

  writePathSync: (path: string): string => {
    try {
      writeFileSync(path, 'probe');
      return 'allowed';
    } catch (cause) {
      return outcome(cause);
    }
  },

  readPath: async (path: string): Promise<string> => {
    try {
      await readFile(path);
      return 'allowed';
    } catch (cause) {
      return outcome(cause);
    }
  },

  /** TCP, through the runtime's own client rather than a raw socket. */
  reachTcp: async (url: string): Promise<string> => {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2_000) });
      return 'connected';
    } catch (cause) {
      return outcome(cause);
    }
  },

  /** The half Landlock does not cover, which is why seccomp is in the child too. */
  sendUdp: async (port: number): Promise<string> =>
    await new Promise<string>((resolve) => {
      let socket;
      try {
        socket = createSocket('udp4');
      } catch (cause) {
        resolve(outcome(cause));
        return;
      }
      // The denial arrives as an `error` event, not as a callback argument:
      // sending forces an implicit bind, and a socket with no listener for
      // that event throws out of the event loop and takes the child with it.
      // Which is a fair description of what a badly written extension does —
      // and the host survives it, but this fixture is not the thing under
      // test, so it listens.
      // Bun's `node:dgram` typings do not declare the emitter half, and the
      // event is where the denial actually arrives, so it is reached through
      // the shape rather than left unhandled.
      const events = socket as unknown as {
        on(event: 'error', listener: (error: Error) => void): void;
      };
      events.on('error', (error) => {
        socket.close();
        resolve(outcome(error));
      });
      socket.send('probe', port, '127.0.0.1', (error) => {
        if (error !== null) return; // The event above is the real answer.
        socket.close();
        resolve('sent');
      });
    }),

  writePath: async (path: string): Promise<string> => {
    try {
      await writeFile(path, 'probe');
      return 'allowed';
    } catch (cause) {
      return outcome(cause);
    }
  },
};
