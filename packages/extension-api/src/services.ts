import { createServiceToken, type Logger } from './core.js';

import type { ArtifactPipeline } from './artifacts.js';
import type { ChatSurfaceHub } from './chat.js';
import type { MessageContent } from './content.js';
import type { BrokerHostPolicy } from './contributions.js';

const CONFIG_KEYS = ['app', 'blueprints', 'brokers', 'memories', 'providers', 'toolSets'] as const;
type ConfigKey = (typeof CONFIG_KEYS)[number];
type ConfigEntryKey = Exclude<ConfigKey, 'app'>;
type ConfigApply = 'hot' | 'restart';
type ConfigSectionKind = 'contribution' | 'directory' | 'file';
type ConfigSectionEditor = 'app' | 'blueprint' | 'broker' | 'contribution' | 'json' | 'toolSet';
type ConfigSectionGroup = 'capabilities' | 'intelligence' | 'machine';

interface ConfigEntrySummaryDescriptor {
  /** Paths whose first scalar values form the compact detail line. */
  readonly detail: readonly string[];
  /** Paths tried in order for the optional longer description. */
  readonly description: readonly string[];
}

interface ConfigUpdate<T> {
  readonly restartRequired: boolean;
  readonly value: T;
}

type RuntimeComponentKind = 'agent' | 'application' | 'broker' | 'memory' | 'provider' | 'toolSet';
type RuntimeComponentState = 'active' | 'applying' | 'failed' | 'restartRequired' | 'unavailable';

interface RuntimeComponentStatus {
  readonly activeGeneration?: number;
  readonly desiredGeneration: number;
  readonly error?: string;
  readonly id: string;
  readonly kind: RuntimeComponentKind;
  readonly state: RuntimeComponentState;
}

interface ToolInventory {
  readonly authority: string;
  readonly description: string;
  readonly name: string;
}

interface ToolSetInventory {
  readonly available: boolean;
  readonly description?: string;
  readonly extensionId?: string;
  readonly id: string;
  readonly name?: string;
  readonly problem?: string;
  readonly tools: readonly ToolInventory[];
  readonly type: string;
}

interface ConfigSectionSummary {
  readonly applies: ConfigApply;
  /** Whether an operator may choose a new entry name without a contribution offering one. */
  readonly creatable: boolean;
  /** What a contribution section can hold. Absent for file and directory sections. */
  readonly contributions?: readonly ConfigContributionSummary[];
  readonly description: string;
  readonly editor: ConfigSectionEditor;
  readonly entries: boolean;
  readonly entrySummary?: ConfigEntrySummaryDescriptor;
  readonly error?: string;
  readonly group: ConfigSectionGroup;
  /** Optional runtime inventory the editor needs in addition to desired configuration. */
  readonly inventory?: 'toolSets';
  readonly key: ConfigKey;
  readonly kind: ConfigSectionKind;
  readonly label: string;
  readonly loaded: boolean;
  readonly name: string;
  readonly plural: string;
  /** Other config sections the editor needs as catalogs for references. */
  readonly references: readonly ConfigKey[];
  readonly slug: string;
  readonly writable: boolean;
}

interface ConfigTypeSchemaDescriptor {
  readonly extensionId: string;
  /** Host behavior declared by broker contributions. Absent for every other point. */
  readonly host?: BrokerHostPolicy;
  readonly instances: 'many' | 'single';
  readonly schema: Readonly<Record<string, unknown>>;
  readonly type: string;
}

/**
 * One contribution a section can hold, without the schema.
 *
 * It rides along with the section summary because a surface listing what is
 * configured also has to show what *could* be and is not: a single-instance
 * contribution with no entry is a thing to fill in, not an absence. The schema
 * is deliberately left out — a catalog is fetched to draw a list, and carrying
 * every JSON Schema for that would pay for a form nobody opened.
 */
interface ConfigContributionSummary {
  readonly configured: boolean;
  readonly extensionId: string;
  readonly instances: 'many' | 'single';
  readonly type: string;
}

interface ConfigSectionSchemaDescriptor {
  readonly applies: ConfigApply;
  readonly key: ConfigKey;
  readonly kind: ConfigSectionKind;
  readonly schema?: Readonly<Record<string, unknown>>;
  readonly types?: readonly ConfigTypeSchemaDescriptor[];
}

interface ConfigRevertTarget {
  readonly entryId?: string;
  readonly key: ConfigKey;
}

interface ConfigurationAdmin {
  readonly revertAvailable: boolean;
  readonly revertTarget?: ConfigRevertTarget;
  read(key: ConfigKey): unknown;
  readEntry(key: ConfigEntryKey, entryId: string): unknown;
  reloadConfiguration(keys?: readonly ConfigKey[]): Promise<void>;
  removeEntry(key: ConfigEntryKey, entryId: string): Promise<boolean>;
  retryRuntime(): Promise<void>;
  revertRuntime(expectedKey?: ConfigKey): Promise<void>;
  runtimeStatuses(): readonly RuntimeComponentStatus[];
  schema(key: ConfigKey): ConfigSectionSchemaDescriptor;
  sections(): readonly ConfigSectionSummary[];
  toolSetInventory(): Promise<readonly ToolSetInventory[]>;
  write(key: ConfigKey, next: unknown): Promise<ConfigUpdate<unknown>>;
  writeEntry(key: ConfigEntryKey, entryId: string, next: unknown): Promise<ConfigUpdate<unknown>>;
}

interface SecretReference {
  readonly location: string;
  readonly secretId: string;
}
interface SecretConsumer {
  readonly extensionId: string;
  readonly location: string;
}
interface SecretSummary {
  readonly createdAt?: number;
  readonly references: readonly SecretReference[];
  readonly secretId: string;
  readonly stored: boolean;
  readonly updatedAt?: number;
}
/** Metadata only. Extension code never receives a capability that can reveal values. */
interface SecretMetadataReader {
  consumers(secretId: string): readonly SecretConsumer[];
  list(): Promise<readonly SecretSummary[]>;
}

interface ExtensionConfiguration {
  get(key: 'app'): Readonly<Record<string, unknown>> & { readonly timezone: string };
  get(key: 'toolSets'): Record<string, unknown>;
  get(key: ConfigKey): unknown;
}

interface ScheduledRunDelivery {
  readonly brokerId: string;
  readonly channelId: string;
}
interface ScheduledRunRequest {
  readonly agentId: string;
  readonly causeId: string;
  readonly delivery?: ScheduledRunDelivery;
  readonly name: string;
  readonly prompt: string;
  readonly sessionId: string;
  readonly signal: AbortSignal;
}
interface ScheduledRunResult {
  readonly completedAt: Date;
  readonly content: readonly MessageContent[];
  readonly deliveredAt?: Date;
  readonly deliveryError?: string;
  readonly error?: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly startedAt: Date;
  readonly status: 'aborted' | 'completed' | 'failed' | 'maxIterations';
}
interface ScheduledRunHost {
  agentIds(signal: AbortSignal): Promise<readonly string[]>;
  deliveryBrokerIds(signal: AbortSignal): Promise<readonly string[]>;
  runScheduledAgent(request: ScheduledRunRequest): Promise<ScheduledRunResult>;
}

const artifactPipelineService = createServiceToken<ArtifactPipeline>('nox.artifact-pipeline');
const chatHubService = createServiceToken<ChatSurfaceHub>('nox.chat-hub');
const configAdminService = createServiceToken<ConfigurationAdmin>('nox.config-admin');
const configService = createServiceToken<ExtensionConfiguration>('nox.config');
/**
 * The directory this installation keeps its own files in.
 *
 * Offered because an extension that needs disk otherwise has to invent a place,
 * and the places it would invent — beside the code, in the working directory —
 * are the ones that do not survive an upgrade or a `cd`. Anything written here
 * belongs to this Nox and moves with it.
 */
const dataDirectoryService = createServiceToken<string>('nox.data-directory');
const loggerService = createServiceToken<Logger>('nox.logger');
const scheduledRunHostService = createServiceToken<ScheduledRunHost>('nox.scheduled-run-host');
const secretStoreService = createServiceToken<SecretMetadataReader>('nox.secret-store');

export {
  artifactPipelineService,
  chatHubService,
  CONFIG_KEYS,
  configAdminService,
  configService,
  dataDirectoryService,
  loggerService,
  scheduledRunHostService,
  secretStoreService,
};

export type {
  ConfigApply,
  ConfigContributionSummary,
  ConfigEntryKey,
  ConfigEntrySummaryDescriptor,
  ConfigKey,
  ConfigRevertTarget,
  ConfigSectionEditor,
  ConfigSectionGroup,
  ConfigSectionKind,
  ConfigSectionSchemaDescriptor,
  ConfigSectionSummary,
  ConfigTypeSchemaDescriptor,
  ConfigUpdate,
  ConfigurationAdmin,
  ExtensionConfiguration,
  RuntimeComponentKind,
  RuntimeComponentState,
  RuntimeComponentStatus,
  ScheduledRunDelivery,
  ScheduledRunHost,
  ScheduledRunRequest,
  ScheduledRunResult,
  SecretConsumer,
  SecretMetadataReader,
  SecretReference,
  SecretSummary,
  ToolInventory,
  ToolSetInventory,
};
