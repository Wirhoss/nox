import { authorities, commands, defineCommand, defineExtension, z } from '@nox/extension-api';

import type {
  CommandContext,
  CommandResult,
  CommandSessionInfo,
  ToolRisk,
} from '@nox/extension-api';

const AUTHORITY = 'nox.commands.session.use';
const noEffects = (): ToolRisk => ({ effects: [] });
const mutation = (reversible: boolean): ToolRisk => ({
  effects: ['write'],
  resources: [{ kind: 'command', value: 'session' }],
  reversible,
});

function sessionText(info: CommandSessionInfo): string {
  const usage = info.contextUsage;
  const context =
    usage.contextWindow === undefined
      ? `${String(usage.usedTokens)} tokens used (window unknown)`
      : `${String(usage.usedTokens)} / ${String(usage.contextWindow)} tokens`;
  return [
    `Session: ${info.sessionId}`,
    `Agent: ${info.agentId}`,
    `Model: ${info.modelId}`,
    `Title: ${info.title ?? '(untitled)'}`,
    `Context: ${context}`,
    `Tools: ${String(info.tools.length)}`,
  ].join('\n');
}

function commandList(context: CommandContext, query?: string): CommandResult {
  const normalized = query?.trim().toLocaleLowerCase();
  const available = context
    .listCommands()
    .filter(
      (command) =>
        normalized === undefined ||
        normalized.length === 0 ||
        command.name.toLocaleLowerCase().includes(normalized) ||
        command.description.toLocaleLowerCase().includes(normalized),
    )
    .map((command) => `/${command.name} — ${command.description}`);
  return {
    text: available.length === 0 ? 'No matching commands.' : available.join('\n'),
  };
}

const sessionCommandsExtension = defineExtension({
  activate(context) {
    context.contributions.register(authorities, AUTHORITY, {
      description: 'Inspect and explicitly change the session behind the current conversation.',
    });

    context.contributions.register(
      commands,
      'commands',
      defineCommand({
        authority: AUTHORITY,
        description: 'Lists the commands published by this Nox.',
        parameters: z.object({
          query: z.string().trim().optional().describe('Optional name or description filter.'),
        }),
        risk: noEffects,
        run: (commandContext, { query }): Promise<CommandResult> =>
          Promise.resolve(commandList(commandContext, query)),
      }),
    );

    context.contributions.register(
      commands,
      'help',
      defineCommand({
        authority: AUTHORITY,
        description: 'Shows the available commands; alias of /commands.',
        parameters: z.object({
          query: z.string().trim().optional().describe('Optional name or description filter.'),
        }),
        risk: noEffects,
        run: (commandContext, { query }): Promise<CommandResult> =>
          Promise.resolve(commandList(commandContext, query)),
      }),
    );

    context.contributions.register(
      commands,
      'session',
      defineCommand({
        authority: AUTHORITY,
        description: 'Shows the current session, agent, model, context, and tool count.',
        parameters: z.object({}),
        risk: noEffects,
        run: (commandContext): Promise<CommandResult> =>
          Promise.resolve({ text: sessionText(commandContext.info()) }),
      }),
    );

    context.contributions.register(
      commands,
      'tools',
      defineCommand({
        authority: AUTHORITY,
        description: 'Lists tools available in the current session.',
        parameters: z.object({}),
        risk: noEffects,
        run: (commandContext): Promise<CommandResult> => {
          const tools = commandContext.info().tools;
          return Promise.resolve({
            text:
              tools.length === 0
                ? 'No tools are available.'
                : tools.map((tool) => `- ${tool}`).join('\n'),
          });
        },
      }),
    );

    context.contributions.register(
      commands,
      'compact',
      defineCommand({
        authority: AUTHORITY,
        description: 'Folds and compacts settled context now.',
        parameters: z.object({}),
        risk: () => ({
          effects: ['network', 'write'],
          resources: [{ kind: 'command', value: 'session:context' }],
          reversible: true,
        }),
        run: async (commandContext): Promise<CommandResult> => {
          const result = await commandContext.compact();
          return {
            text: result.compacted
              ? 'Context compacted.'
              : result.reduced
                ? 'Context reduced losslessly; no summary was needed.'
                : 'Nothing in the settled context could be reduced yet.',
          };
        },
      }),
    );

    context.contributions.register(
      commands,
      'retry',
      defineCommand({
        authority: AUTHORITY,
        description: 'Runs the model again from the current settled context.',
        parameters: z.object({}),
        risk: () => ({
          effects: ['network', 'write'],
          resources: [{ kind: 'command', value: 'session:retry' }],
          reversible: false,
        }),
        run: async (commandContext): Promise<CommandResult> => {
          await commandContext.retry();
          return { text: 'Retry completed.' };
        },
      }),
    );

    context.contributions.register(
      commands,
      'rename',
      defineCommand({
        authority: AUTHORITY,
        description: 'Sets the current session title.',
        parameters: z.object({
          title: z.string().trim().min(1).max(120).describe('New session title.'),
        }),
        risk: () => mutation(true),
        run: async (commandContext, { title }): Promise<CommandResult> => {
          await commandContext.rename(title);
          return { text: `Session renamed to “${title}”.` };
        },
      }),
    );

    context.contributions.register(
      commands,
      'new',
      defineCommand({
        authority: AUTHORITY,
        description: 'Starts a fresh session with the current agent.',
        parameters: z.object({}),
        risk: () => mutation(false),
        run: async (commandContext): Promise<CommandResult> => {
          const next = await commandContext.newSession();
          return { text: `Started session ${next.sessionId} with agent ${next.agentId}.` };
        },
      }),
    );

    context.contributions.register(
      commands,
      'agent',
      defineCommand({
        authority: AUTHORITY,
        description: 'Shows available agents or hands the conversation to a fresh session.',
        parameters: z.object({
          agent: z.string().trim().min(1).optional().describe('Configured agent ID.'),
        }),
        risk: ({ agent }) => (agent === undefined ? noEffects() : mutation(false)),
        run: async (commandContext, { agent }): Promise<CommandResult> => {
          if (agent === undefined) {
            const current = commandContext.info().agentId;
            const agents = commandContext
              .listAgents()
              .map((candidate) => `${candidate === current ? '*' : '-'} ${candidate}`);
            return { text: agents.length === 0 ? 'No agents are available.' : agents.join('\n') };
          }
          const next = await commandContext.switchAgent(agent);
          return {
            text: `Started session ${next.sessionId} with agent ${next.agentId}. The previous transcript remains in Sessions.`,
          };
        },
      }),
    );

    context.contributions.register(
      commands,
      'model',
      defineCommand({
        authority: AUTHORITY,
        description: 'Shows or changes the model for this conversation transcript.',
        parameters: z.object({
          model: z.string().trim().min(1).optional().describe('Model ID on this agent provider.'),
        }),
        risk: ({ model }) => (model === undefined ? noEffects() : mutation(true)),
        run: async (commandContext, { model }): Promise<CommandResult> => {
          if (model === undefined) {
            const models = commandContext
              .listModels()
              .map((candidate) => `${candidate.current ? '*' : '-'} ${candidate.modelId}`);
            return {
              text: models.length === 0 ? 'No models are available.' : models.join('\n'),
            };
          }
          const next = await commandContext.switchModel(model);
          return { text: `This transcript now uses model ${next.modelId}.` };
        },
      }),
    );
  },
});

export default sessionCommandsExtension;
export { sessionCommandsExtension };
