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
export { authorize, GrantAuthorizationProvider } from './authorization';
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
  samePrincipal,
  SYSTEM_CRON,
  SYSTEM_INTERNAL,
  SYSTEM_ISSUER,
  systemAuthority,
} from './principal';

export type { AuthorityDefinition, GrantPattern } from './authority';
export type {
  AuthorizationDecision,
  AuthorizationProvider,
  AuthorizationRequest,
  PrincipalGrants,
  SubjectGroups,
} from './authorization';
export type {
  AuthorizationAuditRecord,
  DecisionAuditSink,
  DecisionStage,
  StoredDecision,
} from './audit';
export type { RunAuthority, RunAuthoritySource } from './principal';
