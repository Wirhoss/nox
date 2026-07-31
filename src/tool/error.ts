import { z } from 'zod';

import { renderTool } from './render';

import type { Tool } from './tool';

type ToolErrorCode =
  | 'invalid_params'
  | 'unknown_tool';


class ToolError extends Error {
  public readonly code: ToolErrorCode;
  public readonly toolName: string;

  constructor(code: ToolErrorCode, toolName: string, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'ToolError';
    this.code = code;
    this.toolName = toolName;
  }
}

class UnknownToolError extends ToolError {
  constructor(toolName: string) {
    super(
      'unknown_tool',
      toolName,
      `Tool "${toolName}" not found. Use search_tool to discover available tools.`,
    );
    this.name = 'UnknownToolError';
  }
}

class InvalidToolParamsError extends ToolError {
  constructor(tool: Tool, error: z.core.$ZodError, cause?: unknown) {
    super(
      'invalid_params',
      tool.name,
      `Invalid params for ${tool.name}:\n${z.prettifyError(error)}\n\n`
      + `Expected signature:\n${renderTool(tool)}\n\n`
      + 'Param values must be plain JSON values (e.g. {"path": "/tmp"}), not wrapper objects.',
      cause,
    );
    this.name = 'InvalidToolParamsError';
  }
}

function isToolError(error: unknown): error is ToolError {
  return error instanceof ToolError;
}

export {
  InvalidToolParamsError,
  isToolError,
  ToolError,
  UnknownToolError,
};

export type {
  ToolErrorCode,
};
