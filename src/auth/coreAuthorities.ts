import { type AuthorityDefinition, CORE_OWNER_ID } from './authority';

/** Attaching a conversation-owned artifact to the user-facing response. */
const ARTIFACT_ATTACH_AUTHORITY = 'nox.artifacts.attach';

/** Reading bytes from an artifact already referenced by this conversation. */
const ARTIFACT_READ_AUTHORITY = 'nox.artifacts.read';

/** Reading the session's own transcript back. */
const HISTORY_SEARCH_AUTHORITY = 'nox.history.search';
const HISTORY_READ_AUTHORITY = 'nox.history.read';

/** The router's own two tools. */
const TOOL_SEARCH_AUTHORITY = 'nox.tools.search';

/**
 * `call_tool` is a doorway, not a capability: what it actually needs is the
 * authority of the tool it was asked to invoke, which is resolved from the
 * prepared execution. This exists so the doorway itself is never the unnamed
 * thing, and so an unbound router still asks for something nobody grants.
 */
const TOOL_CALL_AUTHORITY = 'nox.tools.call';

/**
 * What the core itself owns. Extensions contribute theirs; these belong to no
 * extension, so the core names itself as the owner and stays under `nox.`.
 */
const CORE_AUTHORITIES: readonly AuthorityDefinition[] = Object.freeze([
  Object.freeze({
    description: 'Attach a conversation-owned artifact to the next assistant response.',
    id: ARTIFACT_ATTACH_AUTHORITY,
    ownerExtensionId: CORE_OWNER_ID,
  }),
  Object.freeze({
    description: 'Read an artifact already referenced by this conversation.',
    id: ARTIFACT_READ_AUTHORITY,
    ownerExtensionId: CORE_OWNER_ID,
  }),
  Object.freeze({
    description: 'Read an earlier tool result from this session by track ID.',
    id: HISTORY_READ_AUTHORITY,
    ownerExtensionId: CORE_OWNER_ID,
  }),
  Object.freeze({
    description: 'Keyword-search the complete transcript of this session.',
    id: HISTORY_SEARCH_AUTHORITY,
    ownerExtensionId: CORE_OWNER_ID,
  }),
  Object.freeze({
    description: 'Invoke a tool from the routed catalog, under that tool own authority.',
    id: TOOL_CALL_AUTHORITY,
    ownerExtensionId: CORE_OWNER_ID,
  }),
  Object.freeze({
    description: 'Search the routed tool catalog by capability.',
    id: TOOL_SEARCH_AUTHORITY,
    ownerExtensionId: CORE_OWNER_ID,
  }),
]);

export {
  ARTIFACT_ATTACH_AUTHORITY,
  ARTIFACT_READ_AUTHORITY,
  CORE_AUTHORITIES,
  HISTORY_READ_AUTHORITY,
  HISTORY_SEARCH_AUTHORITY,
  TOOL_CALL_AUTHORITY,
  TOOL_SEARCH_AUTHORITY,
};
