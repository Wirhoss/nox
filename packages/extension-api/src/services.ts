import { createServiceToken } from './core.js';

import type { ArtifactPipeline } from './artifacts.js';
import type { ChatSurfaceHub } from './chat.js';
import type { MessageContent } from './content.js';
import type { BrokerHostPolicy } from './contributions.js';
import type { Logger } from './core.js';
import type { ModelAccess, ModelKind } from './providers.js';

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

/**
 * Runtime answers an editor needs beside the configured document. A section
 * names them rather than the surface guessing: what a tool set exposes and what
 * models a provider actually serves are both facts only the live instance has,
 * and an editor that had to know which sections have which would be a second
 * copy of this table.
 */
type ConfigInventory = 'providers' | 'toolSets';

/**
 * One model an operator may choose, and where the choice comes from.
 *
 * `configured` separates the two answers rather than merging them: a model
 * declared in `modelConfigs` carries metadata this installation depends on —
 * its context window, its dimensions — while one the endpoint merely listed is
 * a name that exists and nothing more. An editor offering both has to say which
 * it is offering.
 */
interface ProviderModelInventory {
  readonly configured: boolean;
  readonly dimensions?: number;
  /** Known only for a declared model; a reported ID says nothing about its kind. */
  readonly kind?: ModelKind;
  readonly modelId: string;
}

/**
 * What one configured provider instance actually serves.
 *
 * `reported` is whether the instance itself answered with a list — an
 * OpenAI-compatible endpoint has `/models`, an engine holding one set of
 * weights knows exactly what it loaded, and an endpoint that refused the
 * question has neither. It is the difference between offering a choice and
 * asking somebody to type an ID from memory, so it is answered here rather than
 * inferred from an empty list.
 */
interface ProviderInventory {
  readonly available: boolean;
  readonly extensionId?: string;
  readonly id: string;
  /** Which model contracts this instance can actually perform. */
  readonly kinds: readonly ModelKind[];
  readonly models: readonly ProviderModelInventory[];
  /** Why the instance is unavailable, when it is. */
  readonly problem?: string;
  readonly reported: boolean;
  /** Why the instance could not list its models, when it could not. */
  readonly reportProblem?: string;
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
  /** Runtime inventories the editor needs in addition to desired configuration. */
  readonly inventory?: readonly ConfigInventory[];
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
  providerInventory(refresh?: boolean): Promise<readonly ProviderInventory[]>;
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
/**
 * Whether the runtime is doing anything a person is waiting on.
 *
 * Deliberately one question and no clock. Extensions that want to work while
 * Nox is quiet each need a different definition of quiet — long enough to be
 * worth a model load, short enough to finish before the next message — and a
 * host that picked one would be choosing on their behalf. So the host answers
 * only what it alone knows, and the extension keeps its own timer.
 *
 * "Busy" is a run in flight, not a session left open: an idle conversation
 * nobody has closed is exactly when background work should be happening.
 */
interface RuntimeActivity {
  /** True while any live session is inside a run. */
  busy(): boolean;
}

interface ScheduledRunHost {
  agentIds(signal: AbortSignal): Promise<readonly string[]>;
  /**
   * Whether this address is one its transport will accept.
   *
   * Asked before a schedule is stored, because the alternative is finding out
   * at the moment the run fires — when the person who could have corrected the
   * address is not there, and the only record is a run that says it delivered.
   *
   * A broker that cannot answer answers true: this is a check that catches a
   * wrong address, not a permission system, and a transport with no way to ask
   * should leave a caller exactly where it was rather than blocking it.
   */
  canDeliverTo(delivery: ScheduledRunDelivery, signal: AbortSignal): Promise<boolean>;
  deliveryBrokerIds(signal: AbortSignal): Promise<readonly string[]>;
  /**
   * Where the transport that owns this session is being spoken to, if one does.
   *
   * The answer to "deliver it back to me": a session reached over a broker
   * knows its own channel, and without this the only way to schedule a reply
   * into the conversation asking for it is for the agent to guess an ID that
   * nothing in its context contains. Undefined for a session with no transport
   * behind it — a scheduled run, or a local one — which is a caller's cue to
   * ask rather than assume.
   */
  deliveryOrigin(sessionId: string, signal: AbortSignal): Promise<ScheduledRunDelivery | undefined>;
  runScheduledAgent(request: ScheduledRunRequest): Promise<ScheduledRunResult>;
}

const artifactPipelineService = createServiceToken<ArtifactPipeline>('nox.artifact-pipeline');
/** The conversation surface itself, which a transport joins rather than uses. */
const chatHubService = createServiceToken<ChatSurfaceHub>('nox.chat-hub', {
  controlPlane: true,
});
/** Writes this installation's configuration; the control plane by definition. */
const configAdminService = createServiceToken<ConfigurationAdmin>('nox.config-admin', {
  controlPlane: true,
});
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
/**
 * The configured models an extension may use for work of its own.
 *
 * Separate from the provider contribution point, which is how a model gets into
 * Nox: this is how one is taken back out. The two are opposite directions and
 * an extension commonly wants both — a memory contributes nothing to providers
 * and still has to embed what it stores.
 */
const modelAccessService = createServiceToken<ModelAccess>('nox.model-access');
/**
 * Whether a person is waiting on the runtime right now.
 *
 * Offered because the alternative an extension has is to guess from its own
 * traffic, and its own traffic is precisely what does not tell it: a memory
 * hears about a turn when the turn is already over, at the exact moment the
 * next one is most likely to start.
 */
const runtimeActivityService = createServiceToken<RuntimeActivity>('nox.runtime-activity');
/** Runs an agent unattended, in a session of its own choosing. */
const scheduledRunHostService = createServiceToken<ScheduledRunHost>('nox.scheduled-run-host', {
  controlPlane: true,
});
/**
 * Metadata only, and still control plane: the list of every secret this
 * installation holds and which extension consumes each one is a map of the
 * credentials worth going after, whether or not it carries their values.
 */
const secretStoreService = createServiceToken<SecretMetadataReader>('nox.secret-store', {
  controlPlane: true,
});

/**
 * Every service token this contract declares.
 *
 * Exists so nothing downstream has to keep a second copy of the roster. A
 * contract test asserts this holds every token the module exports, which is
 * what keeps a service added later from quietly falling out of the checks that
 * read it.
 */
const HOST_SERVICE_TOKENS = Object.freeze([
  artifactPipelineService,
  chatHubService,
  configAdminService,
  configService,
  dataDirectoryService,
  loggerService,
  modelAccessService,
  runtimeActivityService,
  scheduledRunHostService,
  secretStoreService,
]);

/**
 * The services only Nox's own builtins may resolve, derived from the tokens
 * rather than listed again beside them.
 *
 * Published because the check that matters most happens where the tokens are
 * not in hand: discovery reads a manifest, sees strings, and has to answer
 * whether an installed package just asked for the control plane — before the
 * package runs, rather than at whatever later moment it first calls `get`.
 */
const CONTROL_PLANE_SERVICE_IDS: readonly string[] = Object.freeze(
  HOST_SERVICE_TOKENS.filter((token) => token.controlPlane === true)
    .map((token) => token.id)
    .sort((left, right) => left.localeCompare(right)),
);

export {
  artifactPipelineService,
  chatHubService,
  CONFIG_KEYS,
  configAdminService,
  configService,
  CONTROL_PLANE_SERVICE_IDS,
  dataDirectoryService,
  HOST_SERVICE_TOKENS,
  loggerService,
  modelAccessService,
  runtimeActivityService,
  scheduledRunHostService,
  secretStoreService,
};

export type {
  ConfigApply,
  ConfigContributionSummary,
  ConfigEntryKey,
  ConfigEntrySummaryDescriptor,
  ConfigInventory,
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
  ProviderInventory,
  ProviderModelInventory,
  RuntimeActivity,
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
