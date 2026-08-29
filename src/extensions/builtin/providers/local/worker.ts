import { parentPort, workerData } from 'node:worker_threads';

import { loadEngine } from './engineLoader';

import type { EngineOptions, InferenceEngine } from './engine';
import type { HostMessage, WorkerMessage } from './protocol';

/**
 * The worker side of one local model.
 *
 * Loading is started once, lazily, and every call awaits the same promise:
 * requests that arrive during the seconds a model takes to load have to queue
 * rather than fail, or the first thing an operator sees after configuring a
 * model is an error that fixes itself.
 */
const port = parentPort;
if (port === null) throw new Error('The local model worker must run as a worker thread.');

const options = workerData as EngineOptions;
const running = new Map<string, AbortController>();
let engine: Promise<InferenceEngine> | undefined;

function reply(message: WorkerMessage): void {
  port?.postMessage(message);
}

function failure(error: unknown): { aborted: boolean; message: string } {
  const aborted = error instanceof DOMException && error.name === 'AbortError';
  return { aborted, message: error instanceof Error ? error.message : String(error) };
}

async function perform(message: Extract<HostMessage, { kind: 'call' }>): Promise<void> {
  const controller = new AbortController();
  running.set(message.id, controller);
  try {
    engine ??= loadEngine(options);
    const loaded = await engine;
    if (message.call.kind === 'embed') {
      const value = await loaded.embed(message.call, controller.signal);
      reply({ id: message.id, kind: 'settled', value });
    } else {
      // Iterated by hand rather than with `for await`, which discards a
      // generator's return value — and here that value is the measurement.
      const tokens = loaded.generate(message.call, controller.signal);
      let next = await tokens.next();
      while (next.done !== true) {
        reply({ id: message.id, kind: 'chunk', text: next.value });
        next = await tokens.next();
      }
      // The text already crossed as it was produced; what settles is the cost.
      reply({ id: message.id, kind: 'settled', value: next.value });
    }
  } catch (error) {
    reply({ error: failure(error), id: message.id, kind: 'failed' });
  } finally {
    running.delete(message.id);
  }
}

/**
 * Stops on the worker's own terms.
 *
 * Every running call is interrupted and then waited for. The waiting is the
 * point: an interrupted call is still inside the runtime for a moment, and
 * exiting during that moment is indistinguishable from being terminated there.
 */
async function shutdown(): Promise<void> {
  const settling = [...running.values()];
  for (const controller of settling) {
    controller.abort(new DOMException('The local model worker is stopping.', 'AbortError'));
  }
  // The host owns the deadline and will terminate this thread if an interrupt is
  // genuinely stuck. Exiting from inside the worker while a call is still in
  // native code would recreate the process crash graceful shutdown avoids.
  while (running.size > 0) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  port?.close();
  // Closing the port is not leaving: the runtime holds native handles that keep
  // this thread's loop alive, and a thread that stays is one the host will
  // eventually terminate — which is the crash this whole path exists to avoid.
  // Exiting from here happens with the runtime idle, which is the safe moment.
  process.exit(0);
}

port.on('message', (message: HostMessage) => {
  if (message.kind === 'shutdown') {
    void shutdown();
    return;
  }
  if (message.kind === 'cancel') {
    running.get(message.id)?.abort(new DOMException('The model call was aborted.', 'AbortError'));
    return;
  }
  void perform(message);
});
