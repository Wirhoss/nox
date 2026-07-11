import type { Message, Tool } from "../types";

class Context {
  private _systemPrompt: string;
  private _chatHistory: Message[];
  private _tools: Record<string, Tool> = {};

  constructor(systemPrompt: string, chatHistory: Message[], tools: Tool[]) {
    this._systemPrompt = systemPrompt;
    this._chatHistory = chatHistory;
    this._tools = tools.reduce((acc, tool) => {
      acc[tool.name] = tool;
      return acc;
    }, {} as Record<string, Tool>);
  }

  public get systemPrompt(): string {
    return this._systemPrompt;
  }

  public get chatHistory(): Message[] {
    return this._chatHistory;
  }

  public set chatHistory(history: Message[]) {
    this._chatHistory = history;
  }

  public get tools(): Record<string, Tool> {
    return this.tools;
  }

  public addMessage(message: Message): void {
    this._chatHistory.push(message);
  }

  public copy(): Context {
    return new Context(
      this._systemPrompt,
      structuredClone(this._chatHistory),
      Object.values(this._tools).map(tool => structuredClone(tool))
    );
  }
}

export {
  Context
};