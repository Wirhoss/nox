class MessageTooLargeError extends RangeError {
  public override readonly name = 'MessageTooLargeError';

  public readonly messageId: string;
  public readonly estimatedTokens: number;
  public readonly maxMessageTokens: number;

  constructor(messageId: string, estimatedTokens: number, maxMessageTokens: number) {
    super(
      `Message ${messageId} is estimated at ${estimatedTokens} tokens, `
      + `exceeding maxMessageTokens ${maxMessageTokens}.`,
    );
    this.messageId = messageId;
    this.estimatedTokens = estimatedTokens;
    this.maxMessageTokens = maxMessageTokens;
  }
}

export {
  MessageTooLargeError,
};
