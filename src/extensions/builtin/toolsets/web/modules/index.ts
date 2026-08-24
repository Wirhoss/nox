import { camoufoxModule } from './camoufox';
import { crawl4aiModule } from './crawl4ai';
import { searxngModule } from './searxng';

import type { WebModule, WebSlot } from '../module';

/**
 * Every module this tool set knows, by the slot it fills.
 *
 * The list is the whole mechanism. SearXNG, Crawl4AI and camofox are three
 * entries in it and nothing more: none of them is read anywhere by name, none of
 * them is the shape the others are validated against, and a Firecrawl module is
 * a file beside `crawl4ai.ts` plus a line here — no schema to widen, no tool to
 * teach, no branch to add. That is what stops the first module from quietly
 * becoming the definition of its slot.
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
