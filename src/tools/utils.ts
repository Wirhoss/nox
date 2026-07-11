import type { ToolResponse } from "../types";

function asTextToolResponse(result: unknown): ToolResponse {
  return [{ type: "text", text: JSON.stringify(result) }];
}

export {
  asTextToolResponse,
};