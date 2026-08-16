class MessageTooLargeError extends RangeError {
  public override readonly name = "MessageTooLargeError";

  public readonly estimatedTokens: number;
  public readonly maxMessageTokens: number;
  public readonly messageId: string;

  constructor(messageId: string, estimatedTokens: number, maxMessageTokens: number) {
    super(
      `Message ${messageId} is estimated at ${String(estimatedTokens)} tokens, ` +
        `exceeding maxMessageTokens ${String(maxMessageTokens)}.`,
    );
    this.messageId = messageId;
    this.estimatedTokens = estimatedTokens;
    this.maxMessageTokens = maxMessageTokens;
  }
}

export { MessageTooLargeError };
