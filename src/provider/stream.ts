import { nanoid } from 'nanoid';

import { type ArtifactRef, artifactRefSchema } from '../artifact/types';
import { type ProviderError, toProviderError } from './error';

import type { Message, MessageContent, ToolCallMessage } from '../agent/context/message';

interface Usage {
  cacheReadTokens?: number;
  inputTokens: number;
  outputTokens: number;
}

type ToolCallDraft = Omit<ToolCallMessage, 'createdAt' | 'messageId'>;

type ProviderSourceEvent =
  | { type: 'artifact'; artifact: ArtifactRef }
  | { type: 'end'; usage?: Usage }
  | { type: 'error'; error: ProviderError }
  | { type: 'reasoningFragment'; text: string }
  | { type: 'retry'; attempt: number; delayMs: number; error: ProviderError; resetOutput: true }
  | { type: 'textFragment'; text: string }
  | { type: 'toolCall'; toolCall: ToolCallDraft };

type ProviderStreamEvent =
  | { type: 'end'; aborted: boolean; messages: Message[]; usage?: Usage }
  | { type: 'error'; error: ProviderError }
  | { type: 'reasoningFragment'; text: string }
  | { type: 'retry'; attempt: number; delayMs: number; error: ProviderError; resetOutput: true }
  | { type: 'textFragment'; text: string }
  | { type: 'toolCall'; toolCall: ToolCallMessage };

enum StreamStatus {
  OPEN,
  ABORTED,
  FAILED,
  COMPLETED,
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

class ProviderStream {
  private readonly _completed: Promise<Message[]>;
  private reject!: (error: ProviderError) => void;
  private resolve!: (resolve: Message[]) => void;

  private _status: StreamStatus;

  private lastStampMs = 0;

  private readonly queue: ProviderStreamEvent[] = [];
  private readonly waiting: ((event: null | ProviderStreamEvent) => void)[] = [];

  constructor(
    private readonly source: AsyncIterable<ProviderSourceEvent>,
    private readonly abortSignal: AbortSignal,
  ) {
    this._completed = new Promise((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
    this._completed.catch(() => undefined);
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
    for (;;) {
      const queued = this.queue.shift();
      if (queued !== undefined) {
        yield queued;
        continue;
      }
      if (this.status !== StreamStatus.OPEN) return;
      const event = await new Promise<null | ProviderStreamEvent>((resolve) => {
        this.waiting.push(resolve);
      });
      if (event === null) return;
      yield event;
    }
  }

  private fail(error: unknown): void {
    const providerError = toProviderError(error);
    this.push({ error: providerError, type: 'error' });
    this.settleFailed(providerError);
  }

  private finish(messages: Message[], aborted: boolean, usage?: Usage): void {
    this.push({ aborted, messages, type: 'end', usage });
    this.settle(aborted ? StreamStatus.ABORTED : StreamStatus.COMPLETED, () => {
      this.resolve(messages);
    });
  }

  private async pump(): Promise<void> {
    const messages: Message[] = [];
    const iterator = this.source[Symbol.asyncIterator]();

    const assistantContent: MessageContent[] = [];
    let assistantStartedAt: number | undefined;
    let reasoningAccumulated = '';
    let reasoningStartedAt: number | undefined;
    let textAccumulated = '';
    let textStartedAt: number | undefined;
    let assistantMaterialized = false;

    const flushReasoning = (): void => {
      if (reasoningAccumulated.length === 0) return;
      messages.push({
        content: [{ text: reasoningAccumulated, type: 'text' }],
        createdAt: this.stamp(reasoningStartedAt),
        messageId: nanoid(),
        role: 'reasoning',
      });
      reasoningAccumulated = '';
      reasoningStartedAt = undefined;
    };
    const flushText = (): void => {
      if (textAccumulated.length === 0) return;
      assistantStartedAt ??= textStartedAt;
      assistantContent.push({ text: textAccumulated, type: 'text' });
      textAccumulated = '';
      textStartedAt = undefined;
    };
    /** Materializes buffered fragments and discrete outputs as one assistant turn. */
    const flush = (): void => {
      flushReasoning();
      flushText();
      if (assistantContent.length === 0) return;
      messages.push({
        content: assistantContent.splice(0),
        createdAt: this.stamp(assistantStartedAt),
        messageId: nanoid(),
        role: 'assistant',
      });
      assistantMaterialized = true;
      assistantStartedAt = undefined;
    };

    let onAbort: (() => void) | undefined;
    const abort = new Promise<StreamStatus.ABORTED>((resolve) => {
      if (this.abortSignal.aborted) {
        resolve(StreamStatus.ABORTED);
      }
      onAbort = (): void => {
        resolve(StreamStatus.ABORTED);
      };
      this.abortSignal.addEventListener('abort', onAbort, { once: true });
    });

    try {
      for (;;) {
        const next = iterator.next();
        const result = await Promise.race([next, abort]);

        if (result === StreamStatus.ABORTED) {
          void iterator.return?.().catch(() => undefined);
          flush();
          this.finish(messages, true);
          return;
        }

        if (result.done === true) {
          this.fail(new Error('Provider stream ended without an end event'));
          return;
        }

        const event = result.value;

        switch (event.type) {
          case 'artifact': {
            // Bytes were already committed through the run-bound output sink. Only
            // their durable reference enters the provider-independent transcript.
            flushReasoning();
            flushText();
            assistantStartedAt ??= Date.now();
            assistantContent.push({
              artifact: artifactRefSchema.parse(event.artifact),
              type: 'artifact',
            });
            break;
          }
          case 'end': {
            await iterator.return?.();
            flush();
            this.finish(messages, false, event.usage);
            return;
          }
          case 'error': {
            this.fail(event.error);
            return;
          }
          case 'reasoningFragment': {
            reasoningStartedAt ??= Date.now();
            reasoningAccumulated += event.text;
            this.push(event);
            break;
          }
          case 'retry': {
            assistantContent.length = 0;
            assistantStartedAt = undefined;
            reasoningAccumulated = '';
            reasoningStartedAt = undefined;
            textAccumulated = '';
            textStartedAt = undefined;
            assistantMaterialized = false;
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
            // Every tool call belongs to an assistant turn, even when the model
            // emitted reasoning and calls without visible text. Materialize that
            // turn here, before it enters the provider-independent transcript,
            // so folding never has to treat reasoning (or a user turn) as an
            // assistant anchor.
            flush();
            if (!assistantMaterialized) {
              messages.push({
                content: [],
                createdAt: this.stamp(),
                messageId: nanoid(),
                role: 'assistant',
              });
              assistantMaterialized = true;
            }
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
      if (this.abortSignal.aborted || isAbortError(error)) {
        flush();
        this.finish(messages, true);
        return;
      }
      this.fail(error);
    } finally {
      if (onAbort !== undefined) this.abortSignal.removeEventListener('abort', onAbort);
    }
  }

  private push(event: ProviderStreamEvent): void {
    if (this.status !== StreamStatus.OPEN) return;

    const resolve = this.waiting.shift();
    if (resolve === undefined) this.queue.push(event);
    else resolve(event);
  }

  private settle(status: StreamStatus, settleCompletion: () => void): void {
    if (this.status !== StreamStatus.OPEN) return;

    this._status = status;
    settleCompletion();

    for (const resolve of this.waiting.splice(0)) resolve(null);
  }

  private settleFailed(error: ProviderError): void {
    this.settle(StreamStatus.FAILED, () => {
      this.reject(error);
    });
  }

  private stamp(atMs?: number): Date {
    this.lastStampMs = Math.max(atMs ?? Date.now(), this.lastStampMs + 1);
    return new Date(this.lastStampMs);
  }
}

export { ProviderStream, StreamStatus };

export type { ProviderSourceEvent, ProviderStreamEvent, ToolCallDraft, Usage };
