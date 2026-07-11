import { isAbortError } from "../utils";

import type {
  MessageContent,
  MessageContentStreamEvent
} from "../types";

class MessageContentStream {
  private _completed: Promise<MessageContent[]>;
  private resolve!: (r: MessageContent[]) => void;
  private reject!: (e: Error) => void;

  private queue: MessageContentStreamEvent[] = [];
  private waiting: ((event: MessageContentStreamEvent | null) => void)[] = [];
  private closed = false;
  private error?: Error;
  private _aborted = false;

  constructor(
    private source: AsyncIterable<MessageContentStreamEvent>,
    private abortSignal?: AbortSignal,
  ) {
    this._completed = new Promise((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
    this._completed.catch(() => { });
    void this.pump();
  }

  private async pump(): Promise<void> {
    let text = "";
    const toolCalls: MessageContent[] = [];
    const finish = (content: MessageContent[], aborted: boolean) => {
      this.push({ type: "end", content, aborted });
      this._aborted = aborted;
      this.resolve(content);
      this.close();
    };
    const partial = (): MessageContent[] => {
      const content: MessageContent[] = [];
      if (text) content.push({ type: "text", text });
      content.push(...toolCalls);
      return content;
    };
    try {
      for await (const event of this.source) {
        if (event.type === "text") text += event.text;
        else if (event.type === "toolCall") toolCalls.push(event.toolCall);
        else if (event.type === "end") {
          this.push(event);
          this._aborted = event.aborted === true;
          this.resolve(event.content);
          this.close();
          return;
        }
        this.push(event);
      }
      if (this.abortSignal?.aborted) return finish(partial(), true);
      throw new Error("stream ended without an 'end' event");
    } catch (e) {
      if (this.abortSignal?.aborted || isAbortError(e)) {
        return finish(partial(), true);
      }
      this.error = e instanceof Error ? e : new Error(String(e));
      this.reject(this.error);
      this.close();
    }
  }

  private push(event: MessageContentStreamEvent): void {
    if (this.closed) return;
    const waiter = this.waiting.shift();
    if (waiter) waiter(event);
    else this.queue.push(event);
  }

  private close(): void {
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) waiter(null);
  }

  public get completed(): Promise<MessageContent[]> {
    return this._completed;
  }

  public get aborted(): boolean {
    return this._aborted;
  }

  public async *[Symbol.asyncIterator](): AsyncGenerator<MessageContentStreamEvent> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.closed) {
        if (this.error) throw this.error;
        return;
      }
      const event = await new Promise<MessageContentStreamEvent | null>((resolve) => {
        this.waiting.push(resolve);
      });
      if (event === null) {
        if (this.error) throw this.error;
        return;
      }
      yield event;
    }
  }
}

export { MessageContentStream };