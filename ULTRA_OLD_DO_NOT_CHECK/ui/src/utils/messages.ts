/*
 * Readers that turn gateway message shapes into renderable values.
 *
 * Message content is a heterogeneous array (text and images interleaved), so
 * every consumer needs the same narrowing. Keeping it here means the templates
 * stay declarative.
 */

import type { Activity, Content, Message, TextMessage, ToolResponseMessage } from './types';

/** Joins the text parts of a message, dropping images. */
function textContent(message: TextMessage): string {
  return message.content
    .filter((item): item is Extract<Content, { type: 'text' }> => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

/** Same as `textContent`, for the differently named field on tool responses. */
function responseText(message: ToolResponseMessage): string {
  return message.response
    .filter((item): item is Extract<Content, { type: 'text' }> => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

function imageContent(message: TextMessage): Array<Extract<Content, { type: 'image' }>> {
  return message.content.filter((item): item is Extract<Content, { type: 'image' }> => item.type === 'image');
}

/** Resolves an image part to something usable as an `src`. */
function imageSource(image: Extract<Content, { type: 'image' }>): string {
  return image.source.kind === 'url'
    ? image.source.url
    : `data:${image.source.mediaType};base64,${image.source.data}`;
}

/** The label for a tool response varies by how the tool was executed. */
function toolResponseLabel(message: ToolResponseMessage): string {
  if (message.execution === 'deferredAck') return 'Deferred tool accepted';
  if (message.execution === 'deferredResult') return 'Deferred result';
  return 'Tool response';
}

/** One-line summary of an activity event for the inspector timeline. */
function activityLabel(activity: Activity): string {
  const event = activity.event;
  if (event.type === 'error') return event.message;
  if (event.type === 'runStarted') return `Run started · ${event.modelId}`;
  if (event.type === 'runCompleted') return `Run ${event.status} · ${Math.round(event.durationMs)} ms`;
  if (event.type === 'permissionRequest') return `Permission requested · ${event.toolName}`;
  if (event.type === 'permissionResolved') return `Permission ${event.resolution}`;
  if (event.message.role === 'toolCall') return `Called ${event.message.name}`;
  if (event.message.role === 'toolResponse') return `${event.message.name} ${event.message.isError ? 'failed' : 'returned'}`;
  if (event.message.role === 'user') return 'User message accepted';
  if (event.message.role === 'reasoning') return 'Reasoning completed';
  return 'Assistant response completed';
}

/** Reasoning messages are rendered folded into the assistant reply that follows. */
function isFoldedIntoReasoning(messages: Message[], index: number): boolean {
  return messages[index]?.role === 'assistant' && messages[index - 1]?.role === 'reasoning';
}

export {
  activityLabel,
  imageContent,
  imageSource,
  isFoldedIntoReasoning,
  responseText,
  textContent,
  toolResponseLabel,
};
