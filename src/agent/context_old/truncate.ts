import type { Message, MessageContent } from '../../provider';

function truncateMessageText(message: Message, sizeLimit: number): Message {
  if (sizeLimit < 0) return message;
  const truncateContent = (content: MessageContent[]): MessageContent[] => {
    const totalTextLength = content.reduce(
      (total, part) => total + (part.type === 'text' ? part.text.length : 0),
      0,
    );
    if (totalTextLength <= sizeLimit) return content;
    let budget = sizeLimit - 1;
    const parts: MessageContent[] = [];
    for (const part of content) {
      if (part.type !== 'text') {
        parts.push(part);
        continue;
      }
      if (budget <= 0) continue;
      const text = part.text.slice(0, budget);
      budget -= text.length;
      parts.push(text.length === part.text.length ? part : { ...part, text });
    }

    if (sizeLimit > 0) parts.push({ type: 'text', text: '…' });
    return parts;
  };
  if (message.role === 'assistant' || message.role === 'compaction' || message.role === 'fold' || message.role === 'reasoning' || message.role === 'user') {
    const content = truncateContent(message.content);
    return content === message.content ? message : { ...message, content };
  }
  if (message.role === 'toolResponse') {
    const response = truncateContent(message.response);
    return response === message.response ? message : { ...message, response };
  }
  return message;
}

export {
  truncateMessageText,
};
