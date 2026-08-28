import { accounts } from './accounts';
import { artifactBlobs } from './artifactBlobs';
import { artifactRenditions } from './artifactRenditions';
import { artifacts } from './artifacts';
import { authSessions } from './authSessions';
import { backfills } from './backfills';
import { conversations } from './conversations';
import { cronJobs, cronRuns } from './cronJobs';
import { decisions } from './decisions';
import { extensionState } from './extensionState';
import { messageArtifacts } from './messageArtifacts';
import { messages } from './messages';
import { secrets } from './secrets';
import { sessions } from './sessions';

// Every table in one object: consumed by drizzle({ schema }) and by
// drizzle.config.ts. A new table gets its own module here and a line below.
const schema = {
  accounts,
  artifactBlobs,
  artifactRenditions,
  artifacts,
  authSessions,
  backfills,
  conversations,
  cronJobs,
  cronRuns,
  decisions,
  extensionState,
  messageArtifacts,
  messages,
  secrets,
  sessions,
};

export { accounts } from './accounts';
export { artifactBlobs } from './artifactBlobs';
export { artifactRenditions } from './artifactRenditions';
export { artifacts } from './artifacts';
export { authSessions } from './authSessions';
export { backfills } from './backfills';
export { conversations } from './conversations';
export {
  CRON_JOB_KINDS,
  CRON_JOB_STATUSES,
  CRON_RUN_STATUSES,
  cronJobs,
  cronRuns,
} from './cronJobs';
export { decisions } from './decisions';
export { extensionState } from './extensionState';
export { messageArtifacts } from './messageArtifacts';
export { messages } from './messages';
export { schema };
export { secrets } from './secrets';
export { sessions } from './sessions';

export type { AccountRow, AccountRowInsert } from './accounts';
export type { ArtifactBlobRow, ArtifactBlobRowInsert } from './artifactBlobs';
export type { ArtifactRenditionRow, ArtifactRenditionRowInsert } from './artifactRenditions';
export type { ArtifactRow, ArtifactRowInsert } from './artifacts';
export type { AuthSessionRow, AuthSessionRowInsert } from './authSessions';
export type { BackfillRow, BackfillRowInsert } from './backfills';
export type { ConversationRow, ConversationRowInsert } from './conversations';
export type {
  CronJobKind,
  CronJobRow,
  CronJobRowInsert,
  CronJobStatus,
  CronRunRow,
  CronRunRowInsert,
  CronRunStatus,
} from './cronJobs';
export type { DecisionRow, DecisionRowInsert } from './decisions';
export type { ExtensionStateRow, ExtensionStateRowInsert } from './extensionState';
export type { MessageArtifactRow, MessageArtifactRowInsert } from './messageArtifacts';
export type { MessageRow, MessageRowInsert } from './messages';
export type { SecretRow, SecretRowInsert } from './secrets';
export type { SessionRow, SessionRowInsert } from './sessions';
