import { z } from "zod";

import type {
  SyncTool,
  AsyncTool,
  Tool,
  ToolResponse,
  MessageContentImage,
} from "../types";

interface ToolContext {
  abortSignal: AbortSignal;
}

/* ------------------------------------------------------------------ */
/*  Mock SyncTool                                                      */
/* ------------------------------------------------------------------ */

/**
 * Build a `SyncTool` whose `call` returns whatever the callback returns.
 * If no `fn` is given the tool resolves to `{ type: "text", text: name }`.
 */
export function createMockSyncTool<
  S extends z.ZodObject = z.ZodObject,
>(
  name: string,
  description: string,
  parameters: S,
  fn?: (params: z.infer<S>) => Promise<ToolResponse> | ToolResponse,
): SyncTool<S> {
  return {
    type: "sync",
    name,
    description,
    parameters,
    call: async (params) => {
      if (fn) {
        const result = fn(params);
        return result instanceof Promise ? result : result;
      }
      return [{ type: "text", text: name }];
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Mock AsyncTool                                                     */
/* ------------------------------------------------------------------ */

export function createMockAsyncTool<
  S extends z.ZodObject = z.ZodObject,
>(
  name: string,
  description: string,
  parameters: S,
  fn?: (params: z.infer<S>) => Promise<{
    ack: ToolResponse;
    result: Promise<ToolResponse>;
  }>,
): AsyncTool<S> {
  return {
    type: "async",
    name,
    description,
    parameters,
    start: async (params, _ctx: ToolContext) => {
      if (fn) {
        return fn(params);
      }
      return {
        ack: [{ type: "text", text: `Accepted: ${name}` }],
        result: Promise.resolve([{ type: "text", text: `Done: ${name}` }]),
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Quick-tool helpers (no schema needed – use z.any() internally)     */
/* ------------------------------------------------------------------ */

/**
 * One-liner to create a sync tool that always returns `result`.
 * Useful for integration tests that only care about the response payload.
 */
export function mockTool(
  name: string,
  description: string,
  result: ToolResponse,
): SyncTool {
  return createMockSyncTool(name, description, z.object({}), () => result);
}

/**
 * Create a sync tool that throws on call.
 */
export function mockFailingTool(
  name: string,
  description: string,
  error: string | Error,
): SyncTool {
  return createMockSyncTool(name, description, z.object({}), async () => {
    throw typeof error === "string" ? new Error(error) : error;
  });
}

/* ------------------------------------------------------------------ */
/*  Parameterized mock helpers                                         */
/* ------------------------------------------------------------------ */

/**
 * Create a sync tool with a custom zod schema and callback.
 */
export function mockToolFn<S extends z.ZodObject>(
  name: string,
  description: string,
  parameters: S,
  fn: (params: z.infer<S>) => Promise<ToolResponse> | ToolResponse,
): SyncTool<S> {
  return createMockSyncTool(name, description, parameters, fn);
}

/**
 * Create an async tool with a custom zod schema and callback.
 */
export function mockAsyncToolFn<S extends z.ZodObject>(
  name: string,
  description: string,
  parameters: S,
  fn: (params: z.infer<S>) => Promise<{
    ack: ToolResponse;
    result: Promise<ToolResponse>;
  }>,
): AsyncTool<S> {
  return createMockAsyncTool(name, description, parameters, fn);
}

/**
 * Create a sync tool that echoes back the input params as JSON text.
 */
export function mockEchoTool<S extends z.ZodObject>(
  name: string,
  description: string,
  parameters: S,
): SyncTool<S> {
  return createMockSyncTool(name, description, parameters, (params) => [
    { type: "text", text: `Echo: ${JSON.stringify(params)}` },
  ]);
}

/**
 * Create a sync tool that returns an image response.
 */
export function mockImageTool(
  name: string,
  description: string,
  imageSource: MessageContentImage["source"],
): SyncTool {
  return createMockSyncTool(name, description, z.object({}), () => [
    { type: "image", source: imageSource },
  ]);
}

/**
 * Create a sync tool that returns mixed text + image content.
 */
export function mockMixedTool(
  name: string,
  description: string,
  textPart: string,
  imageSource: MessageContentImage["source"],
): SyncTool {
  return createMockSyncTool(name, description, z.object({}), () => [
    { type: "text", text: textPart },
    { type: "image", source: imageSource },
  ]);
}

/**
 * Create a sync tool that delays for `ms` milliseconds before responding.
 */
export function mockSlowTool(
  name: string,
  description: string,
  result: ToolResponse,
  ms: number,
): SyncTool {
  return createMockSyncTool(name, description, z.object({}), async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return result;
  });
}

/**
 * Create an async tool that simulates a long-running job.
 * `ackDelay` is the delay before the acknowledgement,
 * `resultDelay` is the delay before the final result resolves.
 */
export function mockAsyncJobTool(
  name: string,
  description: string,
  ackText: string,
  resultText: string,
  ackDelay = 0,
  resultDelay = 0,
): AsyncTool {
  return createMockAsyncTool(name, description, z.object({}), async (_params) => {
    const ack = async (): Promise<ToolResponse> => {
      if (ackDelay > 0) await new Promise((r) => setTimeout(r, ackDelay));
      return [{ type: "text", text: ackText }];
    };
    const result = async (): Promise<ToolResponse> => {
      if (resultDelay > 0) await new Promise((r) => setTimeout(r, resultDelay));
      return [{ type: "text", text: resultText }];
    };
    return {
      ack: await ack(),
      result: result(),
    };
  });
}

/**
 * Create an async tool whose job fails after some time.
 */
export function mockAsyncFailingTool(
  name: string,
  description: string,
  ackText: string,
  error: string | Error,
  resultDelay = 0,
): AsyncTool {
  return createMockAsyncTool(name, description, z.object({}), async (_params) => {
    return {
      ack: [{ type: "text", text: ackText }],
      result: (async () => {
        if (resultDelay > 0) await new Promise((r) => setTimeout(r, resultDelay));
        throw typeof error === "string" ? new Error(error) : error;
      })(),
    };
  });
}

/**
 * Create a sync tool that tracks how many times it has been called.
 */
export function mockCallCountingTool(
  name: string,
  description: string,
  result: ToolResponse,
): { tool: SyncTool; getCount: () => number; resetCount: () => void } {
  let count = 0;
  return {
    tool: createMockSyncTool(name, description, z.object({}), () => {
      count++;
      return result;
    }),
    getCount: () => count,
    resetCount: () => { count = 0; },
  };
};

/**
 * Create a sync tool that returns different results on each call
 * by cycling through the provided responses.
 */
export function mockRotatingTool(
  name: string,
  description: string,
  responses: ToolResponse[],
): { tool: SyncTool; getCurrentIndex: () => number; reset: () => void } {
  let index = 0;
  return {
    tool: createMockSyncTool(name, description, z.object({}), (_params) => {
      const response = responses[index % responses.length] ?? [{ type: "text", text: "" }];
      index++;
      return response;
    }),
    getCurrentIndex: () => index,
    reset: () => { index = 0; },
  };
};

/**
 * Create a sync tool that simulates a tool with side effects —
 * collects all call arguments in an array for test assertions.
 */
export function mockRecordingTool<S extends z.ZodObject>(
  name: string,
  description: string,
  parameters: S,
  result: ToolResponse,
): { tool: SyncTool<S>; getCalls: () => z.infer<S>[]; reset: () => void } {
  const calls: z.infer<S>[] = [];
  return {
    tool: createMockSyncTool(name, description, parameters, (params) => {
      calls.push(params);
      return result;
    }),
    getCalls: () => calls,
    reset: () => { calls.length = 0; },
  };
};

/**
 * Create a sync tool that returns a structured JSON response.
 */
export function mockJsonTool(
  name: string,
  description: string,
  data: unknown,
): SyncTool {
  return createMockSyncTool(name, description, z.object({}), () => [
    { type: "text", text: JSON.stringify(data) },
  ]);
}

/**
 * Create a sync tool that returns the JSON-encoded params as a concatenated string.
 */
export function mockConcatTool(
  name: string,
  description: string,
  schema: z.ZodObject,
): SyncTool<z.ZodObject> {
  return createMockSyncTool(
    name,
    description,
    schema,
    (params) => [{ type: "text", text: Object.entries(params).map(([k, v]) => `${k}=${v}`).join(" | ") }],
  );
}

/* ------------------------------------------------------------------ */
/*  Pre-built sample tools (useful for quick test scaffolding)         */
/* ------------------------------------------------------------------ */

/** A collection of ready-to-use mock tools covering various response types. */
export const sampleTools: Tool[] = [
  mockTool("read_file", "Read the contents of a file.", [
    { type: "text", text: "file contents here" },
  ]),
  mockTool("write_file", "Write content to a file.", [
    { type: "text", text: "ok" },
  ]),
  mockTool("list_directory", "List files in a directory.", [
    { type: "text", text: "a.txt, b.txt, c.txt" },
  ]),
  mockTool("run_command", "Execute a shell command.", [
    { type: "text", text: "command output" },
  ]),
  mockTool("search_web", "Search the web for information.", [
    { type: "text", text: JSON.stringify([{ title: "Result", url: "https://example.com" }]) },
  ]),
  mockFailingTool("crash_tool", "A tool that always fails.", "boom"),
  mockImageTool("generate_image", "Generate an image from a prompt.", {
    kind: "base64",
    mediaType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  }),
  mockMixedTool("describe_and_show", "Describe something and show an image.", "Here is the result:", {
    kind: "url",
    url: "https://example.com/image.png",
  }),
  mockJsonTool("get_status", "Return the current system status.", {
    status: "healthy",
    uptime: 42,
    version: "1.0.0",
  }),
  mockEchoTool("echo", "Echo back the provided parameters.", z.object({
    message: z.string(),
  })),
];

/* ------------------------------------------------------------------ */
/*  Async sample tools                                                 */
/* ------------------------------------------------------------------ */

/** A collection of ready-to-use mock async tools. */
export const sampleAsyncTools: AsyncTool[] = [
  mockAsyncJobTool(
    "long_running_job",
    "A job that takes a while to complete.",
    "Job started, please wait...",
    "Job completed successfully!",
    0,
    0,
  ),
  mockAsyncFailingTool(
    "failing_job",
    "A job that eventually fails.",
    "Job started...",
    "Job failed unexpectedly",
    0,
  ),
];

/** All sample tools combined (sync + async). */
export const allSampleTools: Tool[] = [...sampleTools, ...sampleAsyncTools];

/* ------------------------------------------------------------------ */
/*  Tool factory helpers for test builders                             */
/* ------------------------------------------------------------------ */

/**
 * Build a `SyncTool` from a plain object definition for inline test use.
 *
 * @example
 *   const tool = sync({ name: "greet", desc: "Say hi", params: z.object({ name: z.string() }), fn: (p) => [{ type: "text", text: `Hello ${p.name}` }] });
 */
export function sync<S extends z.ZodObject>(opts: {
  name: string;
  desc: string;
  parameters: S;
  fn: (params: z.infer<S>) => Promise<ToolResponse> | ToolResponse;
}): SyncTool<S> {
  return createMockSyncTool(opts.name, opts.desc, opts.parameters, opts.fn);
}

/**
 * Build an `AsyncTool` from a plain object definition for inline test use.
 */
export function async_tool<S extends z.ZodObject>(opts: {
  name: string;
  desc: string;
  parameters: S;
  fn: (params: z.infer<S>) => Promise<{
    ack: ToolResponse;
    result: Promise<ToolResponse>;
  }>;
}): AsyncTool<S> {
  return createMockAsyncTool(opts.name, opts.desc, opts.parameters, opts.fn);
}

/**
 * Build a failing `SyncTool` from a plain object definition.
 */
export function failingSync(opts: {
  name: string;
  desc: string;
  parameters?: z.ZodObject;
  error?: string | Error;
}): SyncTool {
  return createMockSyncTool(
    opts.name,
    opts.desc,
    opts.parameters ?? z.object({}),
    async (_params) => {
      throw typeof opts.error === "string" ? new Error(opts.error) : opts.error ?? new Error("mock error");
    },
  );
}

/**
 * Build a failing `AsyncTool` from a plain object definition.
 */
export function failingAsync(opts: {
  name: string;
  desc: string;
  parameters?: z.ZodObject;
  ackText?: string;
  error?: string | Error;
}): AsyncTool {
  return createMockAsyncTool(
    opts.name,
    opts.desc,
    opts.parameters ?? z.object({}),
    async (_params) => ({
      ack: [{ type: "text", text: opts.ackText ?? "Accepted" }],
      result: Promise.reject(typeof opts.error === "string" ? new Error(opts.error) : opts.error ?? new Error("mock error")),
    }),
  );
}
