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
    const value = await (await engine).embed(message.call, controller.signal);
    reply({ id: message.id, kind: 'settled', value });
  } catch (error) {
    reply({ error: failure(error), id: message.id, kind: 'failed' });
  } finally {
    running.delete(message.id);
  }
}

port.on('message', (message: HostMessage) => {
  if (message.kind === 'cancel') {
    running.get(message.id)?.abort(new DOMException('The model call was aborted.', 'AbortError'));
    return;
  }
  void perform(message);
});
