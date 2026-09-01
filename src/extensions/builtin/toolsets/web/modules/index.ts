import { camoufoxModule } from './browser/camoufox';
import { crawl4aiModule } from './extract/crawl4ai';
import { searxngModule } from './search/searxng';

import type { WebModule, WebSlot } from '../module';

/**
 * Every module this tool set knows, by the slot it fills.
 *
 * The list is the whole mechanism. Integrations live below the slot they fill,
 * and none of them is read anywhere else by name or used as the shape another
 * one must validate against. Adding a module means adding its file below the
 * matching slot and one registry entry here — no shared schema to widen, tool to
 * teach or runtime branch to add.
 */
const webModules = Object.freeze({
  browser: Object.freeze([camoufoxModule]),
  extract: Object.freeze([crawl4aiModule]),
  search: Object.freeze([searxngModule]),
}) satisfies { readonly [TSlot in WebSlot]: readonly WebModule<TSlot>[] };

/** The modules that can fill one slot, in the order an operator is offered them. */
function modulesFor<TSlot extends WebSlot>(slot: TSlot): readonly WebModule<TSlot>[] {
  return webModules[slot] as readonly WebModule<TSlot>[];
}

/**
 * The module an entry named. An unknown name is a configuration error rather
 * than a fallback to the first module: an operator who misspells `firecrawl`
 * must not silently get a different service than the one they wrote down.
 */
function moduleFor<TSlot extends WebSlot>(slot: TSlot, id: string): WebModule<TSlot> {
  const found = modulesFor(slot).find((module) => module.id === id);
  if (found === undefined) {
    const known = modulesFor(slot)
      .map((module) => module.id)
      .join(', ');
    throw new Error(`No ${slot} module is called "${id}". Configured modules: ${known}.`);
  }
  return found;
}

export { moduleFor, modulesFor, webModules };
