import {
  describe,
  expect,
  test,
} from 'bun:test';
import { z } from 'zod';

import { Context } from './context';

import type { ChatProvider, Message } from '../../provider';
import type { Tool } from '../../tool';

const createdAt = new Date('2026-01-01T00:00:00.000Z');

function message(messageId: string, role: 'assistant' | 'user', text = messageId): Message {
  return {
    content: [{ text, type: 'text' }],
    createdAt: new Date(createdAt),
    messageId,
    role,
  };
}

function toolCall(messageId: string): Message {
  return {
    arguments: { query: 'stable' },
    createdAt: new Date(createdAt),
    messageId,
    name: 'search',
    role: 'toolCall',
    trackId: messageId,
  };
}

function toolResponse(messageId: string): Message {
  return {
    createdAt: new Date(createdAt),
    execution: 'immediate',
    messageId,
    name: 'search',
    response: [{ text: 'result', type: 'text' }],
    role: 'toolResponse',
    trackId: messageId,
  };
}

function immediateTool(name: string): Tool {
  return {
    description: `${name} description`,
    executionType: 'immediate',
    name,
    parameters: z.object({ query: z.string() }),
    prepare: () => ({ run: async () => [], title: name, type: 'immediate' }),
  };
}

function compactProvider(summary = 'summary'): ChatProvider {
  return {
    getMessageStream: () => ({
      completed: Promise.resolve([{
        content: [{ text: summary, type: 'text' }],
        createdAt: new Date(createdAt),
        messageId: 'provider-summary',
        role: 'assistant',
      }]),
    }),
  } as unknown as ChatProvider;
}

function fixedPromptPrefix(context: Context): string {
  const tools = [
    ...Object.values(context.getTools()),
    ...Object.values(context.getHistorySearchToolSet().tools),
  ].map((tool) => ({
    function: {
      description: tool.description,
      name: tool.name,
      parameters: z.toJSONSchema(tool.parameters, { io: 'input' }),
    },
    type: 'function',
  }));

  return JSON.stringify({
    messages: [{ content: context.getSystemPrompt(), role: 'system' }],
    tools,
  });
}

function serializedMessages(messages: readonly Message[]): string {
  return JSON.stringify(messages);
}

describe('Context prompt-cache stability', () => {
  test('normalizes tool insertion order into the same fixed prefix', () => {
    const first = new Context('system', compactProvider(), {
      tools: {
        zulu: immediateTool('zulu'),
        alpha: immediateTool('alpha'),
      },
    });
    const second = new Context('system', compactProvider(), {
      tools: {
        alpha: immediateTool('alpha'),
        zulu: immediateTool('zulu'),
      },
    });

    expect(fixedPromptPrefix(first)).toBe(fixedPromptPrefix(second));
  });

  test('appending only extends history and leaves the previous request prefix byte-identical', () => {
    const context = new Context('system', compactProvider(), {
      tools: { search: immediateTool('search') },
    });
    context.addMessage(message('first', 'user'));

    const fixedPrefix = fixedPromptPrefix(context);
    const previousHistory = context.getHistory();
    const previousHistoryBytes = serializedMessages(previousHistory);

    context.addMessage(message('second', 'assistant'));
    const nextHistory = context.getHistory();

    expect(fixedPromptPrefix(context)).toBe(fixedPrefix);
    expect(nextHistory[0]).toBe(previousHistory[0]);
    expect(serializedMessages(nextHistory.slice(0, previousHistory.length)))
      .toBe(previousHistoryBytes);
  });

  test('caller-owned tool and message mutations cannot rewrite the stored prefix', () => {
    const tool = immediateTool('search');
    const original = message('first', 'user', 'original');
    const context = new Context('system', compactProvider(), {
      tools: { search: tool },
    });
    context.addMessage(original);

    const fixedPrefix = fixedPromptPrefix(context);
    const historyBytes = serializedMessages(context.getHistory());

    tool.description = 'mutated description';
    if (original.role !== 'user' || original.content[0]?.type !== 'text') {
      throw new Error('Expected user text message.');
    }
    (original.content[0] as { text: string }).text = 'mutated content';
    original.createdAt.setUTCFullYear(1999);

    expect(fixedPromptPrefix(context)).toBe(fixedPrefix);
    expect(serializedMessages(context.getHistory())).toBe(historyBytes);
    expect(Object.isFrozen(context.getTools()['search'])).toBe(true);
  });

  test('folding preserves the cacheable prefix through its assistant anchor', async () => {
    const context = new Context('system', compactProvider());
    context.addMessage(message('anchor', 'assistant'));
    context.addMessage(toolCall('call'));
    context.addMessage(toolResponse('response'));

    const fixedPrefix = fixedPromptPrefix(context);
    const anchor = context.getHistory()[0];
    const anchorBytes = serializedMessages([anchor!]);

    await context.fold();

    expect(fixedPromptPrefix(context)).toBe(fixedPrefix);
    expect(context.getHistory()[0]).toBe(anchor);
    expect(serializedMessages(context.getHistory().slice(0, 1))).toBe(anchorBytes);
  });

  test('compaction preserves the guarded message prefix and only rewrites its suffix', async () => {
    const context = new Context('system', compactProvider(), {
      compactGuardBeginning: 2,
      compactGuardEnd: 0,
      compactMinMessages: 1,
    });
    context.addMessage(message('guarded-user', 'user'));
    context.addMessage(message('guarded-assistant', 'assistant'));
    context.addMessage(message('compact-user', 'user'));
    context.addMessage(message('compact-assistant', 'assistant'));

    const fixedPrefix = fixedPromptPrefix(context);
    const guarded = context.getHistory().slice(0, 2);
    const guardedBytes = serializedMessages(guarded);

    await context.compact();
    const compactedHistory = context.getHistory();

    expect(fixedPromptPrefix(context)).toBe(fixedPrefix);
    expect(compactedHistory[0]).toBe(guarded[0]);
    expect(compactedHistory[1]).toBe(guarded[1]);
    expect(serializedMessages(compactedHistory.slice(0, 2))).toBe(guardedBytes);
    expect(compactedHistory[2]?.role).toBe('compacted');
  });
});
