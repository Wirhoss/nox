import { ToolSet } from '@nox/extension-api';
import { z } from 'zod';

import type { MessageContent, Tool, ToolContext } from '@nox/extension-api';

function text(value: string): MessageContent[] {
  return [{ text: value, type: 'text' }];
}

const greetParameters = z.object({ name: z.string().min(1) });
const ponderParameters = z.object({ ms: z.number().int().min(0) });

const greet: Tool<typeof greetParameters> = {
  authority: 'test.greeter.greet',
  description: 'Greets someone by name.',
  name: 'greet',
  parameters: greetParameters,
  prepare: (params) => ({
    preview: `greet ${params.name}`,
    run: async () => await Promise.resolve(text(`hello ${params.name}`)),
    title: `Greet ${params.name}`,
    type: 'immediate',
  }),
  risk: { effects: ['read'], reversible: true },
};

const ponder: Tool<typeof ponderParameters> = {
  authority: 'test.greeter.ponder',
  description: 'Acknowledges, then answers later.',
  name: 'ponder',
  parameters: ponderParameters,
  prepare: (params) => ({
    run: async (ctx: ToolContext) => {
      const result = (async (): Promise<MessageContent[]> => {
        // The signal is created on the far side of the boundary and armed by a
        // message, so waiting on it is what proves the message got through.
        // `Bun.sleep` would not: it cannot be interrupted, so a tool written
        // with it ignores cancellation and merely finishes into a caller that
        // has stopped listening.
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, params.ms);
          ctx.abortSignal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new DOMException('The call was aborted.', 'AbortError'));
            },
            { once: true },
          );
        });
        return text(`pondered for ${String(params.ms)}ms`);
      })();
      return await Promise.resolve({ ack: text('thinking'), result });
    },
    title: 'Ponder',
    type: 'deferred',
  }),
};

/**
 * A tool set with one of each kind of execution, for the transport tests.
 *
 * It is a real `ToolSet` — the same base class a builtin extends — because what
 * is under test is that the host cannot tell where a set is running, and a
 * hand-rolled stand-in would test the stand-in.
 */
class GreeterToolSet extends ToolSet {
  constructor(enabledTools?: readonly string[]) {
    super('greeter', 'Greets, slowly or otherwise.', enabledTools);
    this.addTools();
  }

  protected override addTools(): void {
    this.registerTool(greet);
    this.registerTool(ponder);
  }
}

export default {
  toolSet: (): ToolSet => new GreeterToolSet(),
};
