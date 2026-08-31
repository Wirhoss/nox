import { z } from '@nox/extension-api';
import { describe, expect, test } from 'bun:test';

import { commandArguments, toDiscordCommand } from './commands';

import type { BrokerCommandSpec, JsonSchema } from '@nox/extension-api';

/** The same conversion the catalog performs, so these specs are not inventions. */
function spec(name: string, description: string, parameters: z.ZodObject): BrokerCommandSpec {
  const { $schema: _draft, ...schema } = z.toJSONSchema(parameters, { io: 'input' });
  return { description, name, parameters: schema as JsonSchema };
}

describe('publishing the catalog', () => {
  test('publishes the built-in stop command with its scope as a picker', () => {
    const mapping = toDiscordCommand(
      spec(
        'stop',
        'Stops the agent: the turn in flight, or the whole conversation.',
        z.object({
          scope: z.enum(['run', 'session']).default('run').describe('run cuts the turn short.'),
        }),
      ),
    );

    expect(mapping).toEqual({
      command: {
        description: 'Stops the agent: the turn in flight, or the whole conversation.',
        name: 'stop',
        options: [
          {
            choices: [
              { name: 'run', value: 'run' },
              { name: 'session', value: 'session' },
            ],
            description: 'run cuts the turn short.',
            name: 'scope',
            required: false,
            type: 3,
          },
        ],
      },
    });
  });

  test('maps every scalar Discord can carry, whatever the command is called', () => {
    const mapping = toDiscordCommand(
      spec(
        'recall',
        'A command that does not exist yet.',
        z.object({
          count: z.number().int(),
          include: z.boolean().optional(),
          ratio: z.number().optional(),
          query: z.string(),
        }),
      ),
    );

    expect('command' in mapping).toBeTrue();
    if (!('command' in mapping)) return;

    expect(
      mapping.command.options.map((option) => [option.name, option.type, option.required]),
    ).toEqual([
      ['count', 4, true],
      ['query', 3, true],
      ['include', 5, false],
      ['ratio', 10, false],
    ]);
  });

  test('describes a parameter that documented nothing with its own name', () => {
    const mapping = toDiscordCommand(
      spec('note', 'Writes a note.', z.object({ text: z.string() })),
    );

    expect('command' in mapping && mapping.command.options[0]?.description).toBe('text');
  });

  test('leaves a command Discord cannot express unpublished rather than degraded', () => {
    const nested = toDiscordCommand(
      spec('plan', 'Plans.', z.object({ steps: z.object({ title: z.string() }) })),
    );
    const list = toDiscordCommand(spec('tag', 'Tags.', z.object({ names: z.array(z.string()) })));

    expect('skip' in nested && nested.skip.reason).toBe('unsupportedParameter');
    expect('skip' in list && list.skip.reason).toBe('unsupportedParameter');
  });
});

describe('reading an invocation back', () => {
  test('collects what was filled in and invents nothing that was not', () => {
    expect(commandArguments([{ name: 'scope', value: 'session' }, { name: 'empty' }])).toEqual({
      scope: 'session',
    });
    expect(commandArguments(undefined)).toEqual({});
  });
});

describe('where a command may be used', () => {
  test('a global command says it works in servers and in direct messages', () => {
    const mapping = toDiscordCommand(spec('stop', 'Stops the agent.', z.object({})), true);

    // A direct message has no commands at all until they are published globally,
    // and a global command that does not say so is offered in servers only.
    expect(mapping).toMatchObject({
      command: { contexts: [0, 1], integration_types: [0] },
    });
  });

  test('a guild command says nothing, because it exists in one server', () => {
    const mapping = toDiscordCommand(spec('stop', 'Stops the agent.', z.object({})));

    expect(mapping).toEqual({
      command: { description: 'Stops the agent.', name: 'stop', options: [] },
    });
  });
});
