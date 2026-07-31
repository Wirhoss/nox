import { stableStringify } from '../../utils';

function callKey(toolName: string, params: unknown): string {
  return `${toolName} ${stableStringify(params)}`;
}

export {
  callKey,
};
