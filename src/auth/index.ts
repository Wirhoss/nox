export {
  AuthorityCatalog,
  authorityDefinitionSchema,
  authorityIdSchema,
  CORE_OWNER_ID,
  isWildcard,
  matchesPattern,
  ownerNamespace,
  UnknownAuthorityError,
} from './authority';
export { AUTHORIZATION_DECIDER, authorize, GrantAuthorizationProvider } from './authorization';
export { ConversationParticipants } from './conversation';
export {
  CORE_AUTHORITIES,
  HISTORY_READ_AUTHORITY,
  HISTORY_SEARCH_AUTHORITY,
  TOOL_CALL_AUTHORITY,
  TOOL_SEARCH_AUTHORITY,
} from './coreAuthorities';
export {
  messageAuthority,
  principal,
  principalKey,
  principalRefSchema,
  principalToString,
  samePrincipal,
  SYSTEM_CRON,
  SYSTEM_INTERNAL,
  SYSTEM_ISSUER,
  systemAuthority,
  systemPrincipal,
} from './principal';

export type { AuthorityDefinition, GrantPattern } from './authority';
export type {
  AuthorizationDecision,
  AuthorizationProvider,
  AuthorizationRequest,
  PrincipalGrants,
} from './authorization';
export type {
  AuthorizationAuditRecord,
  DecisionAuditSink,
  DecisionStage,
  StoredDecision,
} from './audit';
export type { MessageOrigin, PrincipalRef, RunAuthority, RunAuthoritySource } from './principal';
