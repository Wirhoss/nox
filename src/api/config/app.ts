import type { AppConfig } from '../../config/app';
import type { Config } from '../../config/config';

/**
 * An app document whose web-chat route cannot be composed on the next start.
 * The app schema can prove that an agent ID is shaped like a name, but only the
 * blueprint directory can prove that the name exists and whether an explicit
 * choice is required.
 */
class AppReferenceError extends Error {
  public readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`app.json cannot be saved: ${problems.join('; ')}.`);
    this.name = 'AppReferenceError';
    this.problems = Object.freeze([...problems]);
  }
}

/** Applies the same default-agent rules bootstrap uses before app.json is written. */
function assertAppReferences(app: AppConfig, config: Config): void {
  const agentIds = Object.keys(config.get('blueprints')).sort((a, b) => a.localeCompare(b));
  const defaultAgent = app.chat.defaultAgent;

  if (defaultAgent !== undefined && !agentIds.includes(defaultAgent)) {
    throw new AppReferenceError([
      `chat.defaultAgent names "${defaultAgent}", but blueprints configures no such agent`,
    ]);
  }

  if (defaultAgent === undefined && agentIds.length !== 1) {
    throw new AppReferenceError([
      `chat.defaultAgent is required when ${String(agentIds.length)} agents are configured`,
    ]);
  }
}

export { AppReferenceError, assertAppReferences };
