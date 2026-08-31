import { ToolSet, toolSetBaseConfigSchema, z } from '@nox/extension-api';

import { runtimeCredentialSchema, slotSchema, storedCredentialSchema, WEB_SLOTS } from './module';
import { moduleFor, modulesFor } from './modules';
import { browserTools } from './tools/browser';
import { extractTool } from './tools/extract';
import { searchTool } from './tools/search';

import type { CredentialSchema, WebSlot } from './module';

/**
 * One shape, built twice over what fills a credential position: a reference in
 * the stored form, an opaque handle in the runtime form the factory receives.
 *
 * Each slot is a union over its modules rather than a fixed set of fields, so
 * what an entry may write under `search` is decided by the module it names and
 * by nothing else. Adding a module widens the union; it does not touch this
 * file, and it cannot change what an entry naming a different module means.
 */
function createWebConfigSchema(credential: CredentialSchema) {
  return toolSetBaseConfigSchema
    .extend({
      browser: slotSchema(modulesFor('browser'), credential)
        .optional()
        .meta({ nox: { help: 'ui.slot.browserHelp', label: 'ui.slot.browser' } }),
      extract: slotSchema(modulesFor('extract'), credential)
        .optional()
        .meta({ nox: { help: 'ui.slot.extractHelp', label: 'ui.slot.extract' } }),
      search: slotSchema(modulesFor('search'), credential)
        .optional()
        .meta({ nox: { help: 'ui.slot.searchHelp', label: 'ui.slot.search' } }),
      type: z.literal('web'),
    })
    .superRefine((config, context) => {
      if (WEB_SLOTS.every((slot) => config[slot] === undefined)) {
        context.addIssue({
          code: 'custom',
          message: `Configure at least one of ${WEB_SLOTS.join(', ')}.`,
        });
      }
    });
}

const webToolSetConfigSchema = createWebConfigSchema(storedCredentialSchema);
const webToolSetRuntimeSchema = createWebConfigSchema(runtimeCredentialSchema);

type WebToolSetConfig = z.infer<typeof webToolSetConfigSchema>;
type WebToolSetConfigInput = z.input<typeof webToolSetConfigSchema>;
type WebToolSetRuntimeConfig = z.infer<typeof webToolSetRuntimeSchema>;
type WebToolSetRuntimeConfigInput = z.input<typeof webToolSetRuntimeSchema>;

/** What each filled slot is worth saying about the set as a whole. */
const SLOT_SUMMARY: Readonly<Record<WebSlot, string>> = {
  browser: 'drive a real browser',
  extract: 'extract pages as durable files',
  search: 'search the public web',
};

/**
 * The web capability as three slots an operator fills, not as three services
 * Nox happens to know.
 *
 * A slot left empty is a tool that does not exist for the agents holding this
 * instance — an installation with only a search module offers `web_search` and
 * nothing else, and no tool is registered that would fail on its first call.
 * Which service is behind a filled slot is the module's business from here on:
 * this class builds a capability from configuration and hands it to a tool that
 * has never heard of SearXNG.
 */
class WebToolSet extends ToolSet {
  static readonly configSchema = webToolSetConfigSchema;

  readonly #config: WebToolSetRuntimeConfig;

  constructor(input: WebToolSetRuntimeConfigInput) {
    const config = webToolSetRuntimeSchema.parse(input);
    super('Web tools', describe(config), config.enabledTools);
    this.#config = config;
    this.addTools();
  }

  protected override addTools(): void {
    const search = this.#capability('search');
    if (search !== undefined) this.registerTool(searchTool(search, search.origin));

    const extract = this.#capability('extract');
    if (extract !== undefined) this.registerTool(extractTool(extract));

    // The browser is a family rather than a tool: one per action the configured
    // module says it can perform, so what an agent is offered is what the
    // backend can actually do.
    const browser = this.#capability('browser');
    if (browser !== undefined) {
      for (const tool of browserTools(browser, browser.origin)) this.registerTool(tool);
    }
  }

  #capability<TSlot extends WebSlot>(slot: TSlot) {
    const configured = this.#config[slot];
    if (configured === undefined) return undefined;
    return moduleFor(slot, configured.module).create(configured);
  }
}

/** Says what this instance can do, which is what its slots were filled with. */
function describe(config: WebToolSetRuntimeConfig): string {
  const filled = WEB_SLOTS.filter((slot) => config[slot] !== undefined).map(
    (slot) => SLOT_SUMMARY[slot],
  );
  if (filled.length === 0) return 'Web access.';

  const last = filled.pop() ?? '';
  const sentence = filled.length === 0 ? last : `${filled.join(', ')} and ${last}`;
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

export { WebToolSet, webToolSetConfigSchema };

export type { WebToolSetConfig, WebToolSetConfigInput, WebToolSetRuntimeConfigInput };
