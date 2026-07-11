import type { ToolSet } from "../tools/tool";
import type { ToolResponse } from "./message";
import type { z } from "zod";

interface ToolContext {
  abortSignal: AbortSignal;
}

interface SyncTool<S extends z.ZodObject = z.ZodObject> {
  type: "sync";
  name: string;
  description: string;
  parameters: S;
  call: (params: z.infer<S>) => Promise<ToolResponse>;
}

interface AsyncTool<S extends z.ZodObject = z.ZodObject> {
  type: "async";
  name: string;
  description: string;
  parameters: S;
  start: (params: z.infer<S>, ctx: ToolContext) => Promise<{
    ack: ToolResponse;
    result: Promise<ToolResponse>;
  }>;
}

type Tool = SyncTool | AsyncTool;

type ToolSetClass<T extends ToolSet = ToolSet> = new (...args: any[]) => T;

export type {
  AsyncTool,
  SyncTool,
  Tool,
  ToolSetClass
};