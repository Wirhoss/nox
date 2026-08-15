import { nanoid } from 'nanoid';

import { toProviderError } from './error';

import type { ProviderError } from './error';
import type {
  Message,
  ToolCallMessage
} from './message';

interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
}

type ToolCallDraft = Omit<ToolCallMessage, 'createdAt' | 'messageId'>;

type ProviderSourceEvent =
  | { type: 'end'; usage?: Usage }
  | { type: 'error'; error: ProviderError }
  | { type: 'reasoningFragment'; text: string }
  | { type: 'retry'; attempt: number; delayMs: number; error: ProviderError; resetOutput: true }
  | { type: 'textFragment'; text: string }
  | { type: 'toolCall', toolCall: ToolCallDraft }

type ProviderStreamEvent =
  | { type: 'end'; aborted: boolean; messages: Message[]; usage?: Usage }
  | { type: 'error'; error: ProviderError }
  | { type: 'reasoningFragment'; text: string }
  | { type: 'retry'; attempt: number; delayMs: number; error: ProviderError; resetOutput: true }
  | { type: 'textFragment'; text: string }
  | { type: 'toolCall', toolCall: ToolCallMessage }


enum StreamStatus {
  OPEN,
  ABORTED,
  FAILED,
  COMPLETED
}

class ProviderStream {
  private _completed: Promise<Message[]>;
  private resolve!: (resolve: Message[]) => void;
  private reject!: (error: ProviderError) => void;

  private _status: StreamStatus;

  private lastStampMs = 0;

  private readonly queue: ProviderStreamEvent[] = [];
  private readonly waiting: Array<(event: ProviderStreamEvent | null) => void> = [];

  constructor(
    private source: AsyncIterable<ProviderSourceEvent>,
    private abortSignal: AbortSignal,
  ) {
    this._completed = new Promise((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
    this._completed.catch(() => { });
    this._status = StreamStatus.OPEN;

    void this.pump();
  }

  public get completed(): Promise<Message[]> {
    return this._completed;
  }

  public get status(): StreamStatus {
    return this._status;
  }

  public async *[Symbol.asyncIterator](): AsyncGenerator<ProviderStreamEvent> {
    while (true) {
      const queued = this.queue.shift();
      if (queued) {
        yield queued;
        continue;
      }
      if (this.status !== StreamStatus.OPEN) return;
      const event = await new Promise<ProviderStreamEvent | null>((resolve) => {
        this.waiting.push(resolve);
      });
      if (event === null) return;
      yield event;
    }
  }

  private stamp(atMs?: number): Date {
    this.lastStampMs = Math.max(atMs ?? Date.now(), this.lastStampMs + 1);
    return new Date(this.lastStampMs);
  }

  private async pump(): Promise<void> {
    const messages: Message[] = [];
    const iterator = this.source[Symbol.asyncIterator]();

    let reasoningAccumulated = '';
    let reasoningStartedAt: number | undefined;
    let textAccumulated = '';
    let textStartedAt: number | undefined;

    /** Materializes buffered fragments so order matches arrival order. */
    const flush = (): void => {
      if (reasoningAccumulated) {
        messages.push({
          role: 'reasoning',
          content: [{ type: 'text', text: reasoningAccumulated }],
          createdAt: this.stamp(reasoningStartedAt),
          messageId: nanoid(),
        });
        reasoningAccumulated = '';
        reasoningStartedAt = undefined;
      }
      if (textAccumulated) {
        messages.push({
          role: 'assistant',
          content: [{ type: 'text', text: textAccumulated }],
          createdAt: this.stamp(textStartedAt),
          messageId: nanoid(),
        });
        textAccumulated = '';
        textStartedAt = undefined;
      }
    };

    let onAbort: (() => void) | undefined;
    const abort = new Promise<StreamStatus.ABORTED>((resolve) => {
      if (this.abortSignal?.aborted) {
        resolve(StreamStatus.ABORTED);
      }
      onAbort = (): void => resolve(StreamStatus.ABORTED);
      this.abortSignal?.addEventListener('abort', onAbort, { once: true });
    });

    try {
      while (true) {
        const next = iterator.next();
        const result = await Promise.race([next, abort]);

        if (result === StreamStatus.ABORTED) {
          void iterator.return?.().catch(() => { });
          flush();
          this.finish(messages, true);
          return;
        }

        if (result.done) {
          this.fail(messages, new Error('Provider stream ended without an end event'));
          return;
        }

        const event = result.value;

        switch (event.type) {
          case 'end': {
            flush();
            this.finish(messages, false, event.usage);
            return;
          }
          case 'error': {
            this.fail(messages, event.error);
            return;
          }
          case 'reasoningFragment': {
            reasoningStartedAt ??= Date.now();
            reasoningAccumulated += event.text;
            this.push(event);
            break;
          }
          case 'retry': {
            reasoningAccumulated = '';
            reasoningStartedAt = undefined;
            textAccumulated = '';
            textStartedAt = undefined;
            messages.length = 0;
            this.push(event);
            break;
          }
          case 'textFragment': {
            textStartedAt ??= Date.now();
            textAccumulated += event.text;
            this.push(event);
            break;
          }
          case 'toolCall': {
            // Flush first: a tool call always follows the text that requested it.
            flush();
            const toolCall: ToolCallMessage = {
              ...event.toolCall,
              createdAt: this.stamp(),
              messageId: nanoid(),
            };
            messages.push(toolCall);
            this.push({ toolCall, type: 'toolCall' });
            break;
          }
        }
      }
    } catch (error) {
      if (this.abortSignal?.aborted || isAbortError(error)) {
        flush();
        this.finish(messages, true);
        return;
      }
      this.fail(messages, error);
    } finally {
      if (onAbort) this.abortSignal?.removeEventListener('abort', onAbort);
    }
  }

  private finish(messages: Message[], aborted: boolean, usage?: Usage): void {
    this.push({ type: 'end', aborted, messages, usage });
    this.settle(aborted ? StreamStatus.ABORTED : StreamStatus.COMPLETED, messages);
  }

  private fail(messages: Message[], error: unknown): void {
    const providerError = toProviderError(error);
    this.push({ type: 'error', error: providerError });
    this.settle(StreamStatus.FAILED, messages, providerError);
  }

  private push(event: ProviderStreamEvent): void {
    if (this.status !== StreamStatus.OPEN) return;

    const resolve = this.waiting.shift();
    if (resolve) resolve(event);
    else this.queue.push(event);
  }

  private settle(status: StreamStatus, messages: Message[], error?: ProviderError): void {
    if (this.status !== StreamStatus.OPEN) return;

    this._status = status;

    if (status === StreamStatus.COMPLETED || status === StreamStatus.ABORTED) {
      this.resolve(messages);
    } else if (status === StreamStatus.FAILED) {
      this.reject(error!);
    }

    for (const resolve of this.waiting.splice(0)) resolve(null);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export {
  ProviderStream
};

export type {
  ProviderSourceEvent,
  ProviderStreamEvent,
  ToolCallDraft,
  Usage,
};
