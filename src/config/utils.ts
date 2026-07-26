import { mkdir, readdir } from 'node:fs/promises';

import { createLogger } from '../logger';

const logger = createLogger('config');

export async function readConfigFile<T>( filePath: string, defaultConfig: T ): Promise<T> {
  const file = Bun.file(filePath);

  if (!(await file.exists())) {
    logger.info({ filePath }, 'Configuration file missing, writing defaults.');
    await mkdir(filePath.substring(0, filePath.lastIndexOf('/')), {
      recursive: true,
    }).catch((error: unknown) => {
      logger.warn({ err: error, filePath }, 'Could not create the configuration directory.');
    });
    await Bun.write(file, JSON.stringify(defaultConfig, null, 2));
    return defaultConfig;
  } else if(file.size === 0) {
    logger.warn({ filePath }, 'Configuration file is empty, restoring defaults.');
    await Bun.write(file, JSON.stringify(defaultConfig, null, 2));
    return defaultConfig;
  }

  return JSON.parse(await file.text()) as T;
}

export async function readConfigDirectory<T>( dirPath: string, defaultConfig: T[] ): Promise<T[]> {
  await mkdir(dirPath, { recursive: true }).catch((error: unknown) => {
    logger.warn({ dirPath, err: error }, 'Could not create the configuration directory.');
  });

  // A directory that cannot be read yields an empty config, which otherwise
  // looks exactly like "nothing is configured yet".
  const entries = await readdir(dirPath, { withFileTypes: true }).catch((error: unknown) => {
    logger.error({ dirPath, err: error }, 'Could not read the configuration directory.');
    return [];
  });
  const jsonFiles = entries
    .filter(dirent => dirent.isFile() && dirent.name.endsWith('.json'))
    .map(dirent => `${dirPath}/${dirent.name}`);

  const results: T[] = [];
  for (const filePath of jsonFiles) {
    const content = await Bun.file(filePath).text().catch((error: unknown) => {
      logger.error({ err: error, filePath }, 'Could not read a configuration file, skipping it.');
      return null;
    });
    if (content && content.trim().length > 0) {
      const parsed = JSON.parse(content);
      results.push(parsed);
    }
  }

  logger.debug({ dirPath, fileCount: jsonFiles.length, loaded: results.length }, 'Configuration directory read.');
  return results.length > 0 ? results : defaultConfig;
}
