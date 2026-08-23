import { CORE_OWNER_ID } from '../auth/authority';
import { ROUTER_TOOL_NAMES, ToolRouter } from '../tool/router';
import { bindTool, type Tool, type ToolSetGrant } from '../tool/tool';

import type { AuthorityCatalog } from '../auth/authority';

const ROUTER_TOOL_NAME_SET = new Set<string>(ROUTER_TOOL_NAMES);

/**
 * Everything that has to be true of a set of grants before an agent can run on
 * them, in one place because there is exactly one answer: a blueprint either
 * composes into a working tool table or it does not, and a surface that judged
 * it by its own copy of these rules would eventually disagree with the session
 * that has to live with them.
 *
 * It is deliberately a pure function of the grants and the catalog. Nothing here
 * opens anything, so a caller that only wants to know whether a configuration
 * would work — rather than to run on it — can ask by calling it and discarding
 * the answer.
 */
function snapshotToolSets(
  grants: readonly ToolSetGrant[],
  kind: 'direct' | 'routed',
  authorities: AuthorityCatalog,
): Readonly<Record<string, Tool>> {
  const tools = new Map<string, Tool>();
  const toolSetIds = new Set<string>();

  for (const { toolSet, toolSetId, tools: granted } of [...grants]) {
    if (toolSetIds.has(toolSetId)) {
      throw new Error(`${kind} tool set ${toolSetId} is granted more than once.`);
    }
    toolSetIds.add(toolSetId);

    const exposed = toolSet.tools;

    // A named tool the set does not expose is a typo in a blueprint, and the
    // quiet reading of one — grant nothing — is the reading that costs an hour
    // to notice. It fails here, where the set and the name are both in hand.
    for (const name of granted ?? []) {
      if (exposed[name] === undefined) {
        throw new Error(`${kind} tool set ${toolSetId} does not expose tool ${name}.`);
      }
    }

    const allowed = granted === undefined ? undefined : new Set(granted);
    for (const [name, source] of Object.entries(exposed)) {
      if (allowed !== undefined && !allowed.has(name)) continue;
      if (source.name !== name) {
        throw new Error(`${kind} tool key ${name} does not match tool name ${source.name}.`);
      }
      if (ROUTER_TOOL_NAME_SET.has(name)) {
        throw new Error(`${kind} tool ${name} conflicts with a tool router tool.`);
      }
      if (tools.has(name)) {
        throw new Error(`${kind} tool ${name} is granted by more than one tool set.`);
      }
      authorities.assertKnown(source.authority, `${kind} tool "${name}" in set "${toolSetId}"`);

      // Trust is a claim about whose writing the output is, so an extension
      // declaring its own output trusted is the whole attack in one line. The
      // catalog already knows who owns an authority, and only the core owns
      // tools whose output the core itself composed.
      if (
        source.trust === 'trusted' &&
        authorities.get(source.authority)?.ownerExtensionId !== CORE_OWNER_ID
      ) {
        throw new Error(
          `${kind} tool ${name} in set ${toolSetId} declares trusted output, which only ` +
            'tools under a core-owned authority may do.',
        );
      }

      tools.set(name, bindTool(source, toolSetId));
    }
  }

  return Object.freeze(Object.fromEntries([...tools].sort(([a], [b]) => a.localeCompare(b))));
}

/**
 * The tool table a session opens with: direct sets as themselves, routed sets
 * behind the router. Throws on anything that would make the table ambiguous,
 * because a session that started with two different tools answering to one name
 * would resolve the ambiguity silently and differently each time.
 */
function composeSessionTools(
  directSource: readonly ToolSetGrant[],
  routedSource: readonly ToolSetGrant[],
  authorities: AuthorityCatalog,
): Readonly<Record<string, Tool>> {
  const directTools = snapshotToolSets(directSource, 'direct', authorities);
  const routedTools = snapshotToolSets(routedSource, 'routed', authorities);

  for (const name of Object.keys(routedTools)) {
    if (directTools[name] !== undefined) {
      throw new Error(`Tool ${name} cannot be both direct and routed.`);
    }
  }

  const routed = Object.values(routedTools);
  if (routed.length === 0) return directTools;

  const router = new ToolRouter(routed);
  const routerTools = Object.fromEntries(
    Object.entries(router.tools).map(([name, tool]) => [name, bindTool(tool, 'nox.router')]),
  );
  return Object.freeze({ ...directTools, ...routerTools });
}

export { composeSessionTools, snapshotToolSets };
