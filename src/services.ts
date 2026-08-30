import {
  type ConfigurationAdmin,
  artifactPipelineService as extensionArtifactPipelineService,
  chatHubService as extensionChatHubService,
  configAdminService as extensionConfigAdminService,
  configService as extensionConfigService,
  dataDirectoryService as extensionDataDirectoryService,
  loggerService as extensionLoggerService,
  modelAccessService as extensionModelAccessService,
  runtimeActivityService as extensionRuntimeActivityService,
  scheduledRunHostService as extensionScheduledRunHostService,
  secretStoreService as extensionSecretStoreService,
  type RuntimeActivity,
  type ScheduledRunHost,
  type ServiceToken,
} from '@nox/extension-api';

import type { ChatHub } from './api/chat';
import type { ArtifactPipeline } from './artifact/pipeline';
import type { Config } from './config/config';
import type { SecretStore } from './config/secrets';
import type { Logger } from './logger/logger';
import type { ModelAccessRelay } from './runtime/modelAccess';

/** Host-side views retain concrete implementation types without widening the public API. */
function hostView<T>(token: { readonly id: string }): ServiceToken<T> {
  return token;
}

const artifactPipelineService = hostView<ArtifactPipeline>(extensionArtifactPipelineService);
const chatHubService = hostView<ChatHub>(extensionChatHubService);
const configAdminService = hostView<ConfigurationAdmin>(extensionConfigAdminService);
const configService = hostView<Config>(extensionConfigService);
const dataDirectoryService = hostView<string>(extensionDataDirectoryService);
const loggerService = hostView<Logger>(extensionLoggerService);
const modelAccessService = hostView<ModelAccessRelay>(extensionModelAccessService);
const runtimeActivityService = hostView<RuntimeActivity>(extensionRuntimeActivityService);
const scheduledRunHostService = hostView<ScheduledRunHost>(extensionScheduledRunHostService);
const secretStoreService = hostView<SecretStore>(extensionSecretStoreService);

export {
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
};
