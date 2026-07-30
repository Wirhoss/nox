import type { Message } from '../../provider';

function formatHistoryMessage(message: Message): string {
  let formatted = `Role: ${message.role}`;
  if (message.role === 'assistant' || message.role === 'compaction' || message.role === 'fold' || message.role === 'reasoning' || message.role === 'user') {
    for (const content of message.content) {
      if (content.type === 'text') {
        formatted += `\nContent: ${content.text}`;
      } else if (content.type === 'image') {
        formatted += `\nContent: [Image: ${content.source.type === 'url' ? content.source.url : 'base64 data'}]`;
      }
    }
  } else if (message.role === 'toolCall') {
    formatted += `\nTool Name: ${message.name}`
      + `\nTrack Id: ${message.trackId}`
      + `\nArguments: ${JSON.stringify(message.arguments)}`;
  } else if (message.role === 'toolResponse') {
    formatted += `\nTool Name: ${message.name}`
      + `\nTrack Id: ${message.trackId}`
      + `\nExecution: ${message.execution}`
      + `\nResponse: ${JSON.stringify(message.response)}`
      + `\nWas Error: ${message.isError ?? 'unknown'}`
      + `\nWas Deferred: ${message.execution === 'deferredAck'}`;
  }
  return formatted;
}

export {
  formatHistoryMessage,
};
