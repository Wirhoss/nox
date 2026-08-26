import { createServiceToken } from './extensions/service';

import type { ArtifactPipeline } from './artifact/pipeline';
import type { Config } from './config/config';
import type { SecretStore } from './config/secrets';
import type { Database } from './database/database';
import type { Logger } from './logger/logger';
import type { ScheduledRunHost } from './scheduler/scheduledRun';

/**
 * The host services a contribution may ask for. Types only — a token carries no
 * implementation, so declaring these keeps the kernel free of concrete imports.
 */
const artifactPipelineService = createServiceToken<ArtifactPipeline>('nox.artifact-pipeline');
const configService = createServiceToken<Config>('nox.config');
const databaseService = createServiceToken<Database>('nox.database');
const loggerService = createServiceToken<Logger>('nox.logger');
const scheduledRunHostService = createServiceToken<ScheduledRunHost>('nox.scheduled-run-host');
const secretStoreService = createServiceToken<SecretStore>('nox.secret-store');

export {
  artifactPipelineService,
  configService,
  databaseService,
  loggerService,
  scheduledRunHostService,
  secretStoreService,
};
