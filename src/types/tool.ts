import type { z } from "zod";
import type { ToolResponse } from "./message";

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
    ack: ToolResponse;          // lo que ve el modelo ya ("task abc123 iniciada")
    result: Promise<ToolResponse>; // lo que llegará después
  }>;
}

type Tool = SyncTool | AsyncTool;

export type {
  Tool,
};