import type { Message } from '../provider';
import type { Tool } from '../tool';
class Context {
  public inputTokens: number = 0;
  public outputTokens: number = 0;
  public cacheReadTokens: number = 0;

  public systemPrompt: string;

  public messageHistory: Message[] = [];
  public fullMessageHistory: Message[] = [];

  public tools: Record<string, Tool> = {};

  public readonly sessionId?: string;

  private checkpointIndex?: number;

  constructor(systemPrompt: string, sessionId?: string) {
    this.systemPrompt = systemPrompt;
    this.sessionId = sessionId;
    this.messageHistory = [];
    this.fullMessageHistory = [];
  }
  
  public addMessage(message: Message): void {
    this.messageHistory.push(message);
    this.fullMessageHistory.push(message);
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
  }

  public compact(): void {
    // NO-OP for now
  }
}

export { Context };