import { createServiceToken } from './extensions/service';

import type { Config } from './config/config';
import type { SecretStore } from './config/secrets';
import type { Database } from './database/database';
import type { Logger } from './logger/logger';

/**
 * The host services a contribution may ask for. Types only — a token carries no
 * implementation, so declaring these keeps the kernel free of concrete imports.
 */
const configService = createServiceToken<Config>('nox.config');
const databaseService = createServiceToken<Database>('nox.database');
const loggerService = createServiceToken<Logger>('nox.logger');
const secretStoreService = createServiceToken<SecretStore>('nox.secret-store');

export { configService, databaseService, loggerService, secretStoreService };
