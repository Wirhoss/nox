import type {
  Message,
  ToolCallMessage
} from './message';

interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
}

type ProviderStreamEvent =
  | { type: 'end'; aborted?: boolean; messages: Message[]; usage?: Usage }
  | { type: 'error'; error: Error }
  | { type: 'reasoningFragment'; text: string }
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
  private reject!: (error: Error) => void;

  private _status: StreamStatus;

  private readonly queue: ProviderStreamEvent[] = [];
  private readonly waiting: Array<(event: ProviderStreamEvent | null) => void> = [];

  constructor(
    private source: AsyncIterable<ProviderStreamEvent>,
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

  private async pump(): Promise<void> {
    let reasoningAccumulated = '';
    let textAccumulated = '';
    const messages: Message[] = [];
    const iterator = this.source[Symbol.asyncIterator]();

    let onAbort: (() => void) | undefined;
    const abort = new Promise<StreamStatus.ABORTED>((resolve) => {
      if (this.abortSignal?.aborted) {
        resolve(StreamStatus.ABORTED);
      }
      onAbort = () => resolve(StreamStatus.ABORTED);
      this.abortSignal?.addEventListener('abort', onAbort, { once: true });
    });

    try {
      while (true) {
        const next = iterator.next();
        const result = await Promise.race([next, abort]);

        if (result === StreamStatus.ABORTED) {
          void iterator.return?.().catch(() => { });
          if (reasoningAccumulated) {
            messages.push({ role: 'reasoning', content: [{ type: 'text', text: reasoningAccumulated }] });
          }
          if (textAccumulated) {
            const assistantMessage: Message = { role: 'assistant', content: [{ type: 'text', text: textAccumulated }] };
            messages.push(assistantMessage);
          }
          this.finish(messages, true);
          return;
        }

        if (result.done) {
          this.fail(messages, new Error('Provider stream ended without an end event'));
          return;
        }

        const event = result.value;

        if (event.type === 'end') {
          const completedMessages = reasoningAccumulated.length > 0
            ? [
              { role: 'reasoning' as const, content: [{ type: 'text' as const, text: reasoningAccumulated }] },
              ...event.messages,
            ]
            : event.messages;
          this.finish(completedMessages, false, event.usage);
          return;
        } else if (event.type === 'error') {
          this.fail(messages, event.error);
          return;
        } else if (event.type === 'reasoningFragment') {
          reasoningAccumulated += event.text;
        } else if (event.type === 'textFragment') {
          textAccumulated += event.text;
        } else if (event.type === 'toolCall') {
          messages.push(event.toolCall);
        }

        this.push(event);
      }
    } catch (error) {
      if (this.abortSignal?.aborted || isAbortError(error)) {
        if (reasoningAccumulated) {
          messages.push({ role: 'reasoning', content: [{ type: 'text', text: reasoningAccumulated }] });
        }
        if (textAccumulated) {
          const assistantMessage: Message = { role: 'assistant', content: [{ type: 'text', text: textAccumulated }] };
          messages.push(assistantMessage);
        }
        this.finish(messages, true);
        return;
      }
      this.fail(messages, error as Error);
    } finally {
      if (onAbort) this.abortSignal?.removeEventListener('abort', onAbort);
    }
  }

  private finish(messages: Message[], aborted: boolean, usage?: Usage): void {
    this.push({ type: 'end', aborted, messages, usage });
    this.settle(aborted ? StreamStatus.ABORTED : StreamStatus.COMPLETED, messages);
  }

  private fail(messages: Message[], error: Error): void {
    this.push({ type: 'error', error });
    this.settle(StreamStatus.FAILED, messages, error);
  }

  private push(event: ProviderStreamEvent): void {
    if (this.status !== StreamStatus.OPEN) return;

    const resolve = this.waiting.shift();
    if (resolve) resolve(event);
    else this.queue.push(event);
  }

  private settle(status: StreamStatus, messages: Message[], error?: Error): void {
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
  ProviderStreamEvent,
  Usage,
};
