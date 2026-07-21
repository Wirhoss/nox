import type { Message } from '../provider';
import type { Tool } from '../tool';

interface ContextListener {
  onMessageAdded(index: number, message: Message): void;
  onHistoryTruncated(length: number): void;
}

class Context {
  private readonly sessionId?: string;

  private inputTokens: number = 0;
  private outputTokens: number = 0;
  private cacheReadTokens: number = 0;

  private systemPrompt: string;
  private messageHistory: Message[] = [];
  private fullMessageHistory: Message[] = [];
  private tools: Record<string, Tool> = {};
  private _listener?: ContextListener;
  private checkpointIndex?: number;

  public get listener(): ContextListener | undefined {
    return this._listener;
  }

  constructor(systemPrompt: string, sessionId?: string) {
    this.systemPrompt = systemPrompt;
    this.sessionId = sessionId;
    this.messageHistory = [];
    this.fullMessageHistory = [];
  }
  
  public addMessage(message: Message): void {
    this.messageHistory.push(message);
    this.fullMessageHistory.push(message);
    this._listener?.onMessageAdded(this.messageHistory.length - 1, message);
  }

  public saveCheckpoint(): void {
    this.checkpointIndex = this.messageHistory.length;
  }

  public restoreCheckpoint(): void {
    if (this.checkpointIndex === undefined) {
      throw new Error('No checkpoint to restore.');
    }
    this.messageHistory = this.messageHistory.slice(0, this.checkpointIndex);
    this.checkpointIndex = undefined;
    this.listener?.onHistoryTruncated(this.messageHistory.length);
  }

  public compact(): void {
    // NO-OP for now
  }
}

export { Context };
export type { ContextListener };