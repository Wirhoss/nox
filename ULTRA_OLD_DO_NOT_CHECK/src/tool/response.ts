import type { MessageContentText } from '../provider';

function asTextToolResponse(result: unknown): MessageContentText[] {
  return [{ type: 'text', text: JSON.stringify(result) }];
}

export {
  asTextToolResponse,
};
