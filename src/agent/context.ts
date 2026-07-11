import type { Message, Tool } from "../types";

class Context {
  private _systemPrompt: string;
  private _chatHistory: Message[];
  private _tools: Record<string, Tool> = {};

  private _inputTokens: number = 0;
  private _outputTokens: number = 0;
  private _cacheReadTokens: number = 0;

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
    return this._tools;
  }

  public get inputTokens(): number {
    return this._inputTokens;
  }

  public get outputTokens(): number {
    return this._outputTokens;
  }

  public get cacheReadTokens(): number {
    return this._cacheReadTokens;
  }

  public set inputTokens(value: number) {
    this._inputTokens = value;
  }

  public set outputTokens(value: number) {
    this._outputTokens = value;
  }

  public set cacheReadTokens(value: number) {
    this._cacheReadTokens = value;
  }

  public addMessage(message: Message): void {
    this._chatHistory.push(message);
  }
}

export {
  Context
};