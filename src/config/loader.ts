import { mkdir, readdir } from 'node:fs/promises';

import { z } from 'zod';

import { createLogger } from '../logger';
import { diffPaths, stableStringify } from '../utils';

import { ConfigError } from './error';

import type { ConfigSection, DirectorySection, FileSection } from './section';

const logger = createLogger('config');

function directoryOf(filePath: string): string {
  return filePath.slice(0, filePath.lastIndexOf('/'));
}

async function readJson(filePath: string): Promise<unknown> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return undefined;

  const text = await file.text().catch((error: unknown) => {
    throw new ConfigError('unreadable', filePath, 'could not be read.', error);
  });
  if (text.trim().length === 0) return undefined;

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConfigError('invalid_json', filePath, 'is not valid JSON.', error);
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  try {
    await mkdir(directoryOf(filePath), { recursive: true });
    await Bun.write(filePath, `${JSON.stringify(value, null, 2)}\n`);
  } catch (error) {
    throw new ConfigError('unwritable', filePath, 'could not be written.', error);
  }
}

function parseDocument<T>(
  schema: z.ZodType<T>,
  source: unknown,
  filePath: string,
): { value: T; added: string[] } {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(
      'invalid_schema',
      filePath,
      `does not match its schema.\n${z.prettifyError(parsed.error)}`,
    );
  }

  const { added, removed } = diffPaths(source, parsed.data);
  if (removed.length > 0) {
    throw new ConfigError(
      'unknown_keys',
      filePath,
      `has keys no setting matches: ${removed.join(', ')}.`,
    );
  }

  return { added, value: parsed.data };
}

async function materialize<T>(
  filePath: string,
  source: unknown,
  parsed: T,
  added: string[],
): Promise<void> {
  if (stableStringify(source) === stableStringify(parsed)) return;

  await writeJson(filePath, parsed);
  logger.info({ added, path: filePath }, 'Configuration file updated with current defaults.');
}

async function loadFileSection<T>(section: FileSection<T>, configDir: string): Promise<T> {
  const filePath = `${configDir}/${section.name}`;
  const source = await readJson(filePath);

  if (source === undefined) {
    const { value } = parseDocument(section.schema, {}, filePath);
    await writeJson(filePath, value);
    logger.info({ path: filePath }, 'Configuration file generated with defaults.');
    return value;
  }

  const { added, value } = parseDocument(section.schema, source, filePath);
  await materialize(filePath, source, value, added);
  return value;
}

async function loadDirectorySection<T>(
  section: DirectorySection<T>,
  configDir: string,
): Promise<Record<string, T>> {
  const dirPath = `${configDir}/${section.name}`;

  try {
    await mkdir(dirPath, { recursive: true });
  } catch (error) {
    throw new ConfigError('unwritable', dirPath, 'could not be created.', error);
  }

  const entries = await readdir(dirPath, { withFileTypes: true }).catch((error: unknown) => {
    throw new ConfigError('unreadable', dirPath, 'could not be read.', error);
  });

  const result: Record<string, T> = {};
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;

    const filePath = `${dirPath}/${entry.name}`;
    const source = await readJson(filePath);
    if (source === undefined) {
      logger.warn({ path: filePath }, 'Configuration file is empty; skipping it.');
      continue;
    }

    const { added, value } = parseDocument(section.entrySchema, source, filePath);
    await materialize(filePath, source, value, added);
    result[entry.name.slice(0, -'.json'.length)] = value;
  }

  return result;
}

function loadSection<T>(
  section: ConfigSection<T>,
  configDir: string,
): Promise<Record<string, T> | T> {
  return section.kind === 'file'
    ? loadFileSection(section, configDir)
    : loadDirectorySection(section, configDir);
}

export {
  loadDirectorySection,
  loadFileSection,
  loadSection,
  parseDocument,
  readJson,
  writeJson,
};
