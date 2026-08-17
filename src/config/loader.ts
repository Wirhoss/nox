import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

import { diffPaths, stableStringify } from '../utils/json';
import { ConfigError } from './error';

import type { Logger } from '../logger/logger';

interface ParsedDocument<T> {
  added: string[];
  value: T;
}

interface LoaderContext {
  configDir: string;
  logger: Logger;
}

const RENAME_RETRY_DELAYS_MS = [1, 4, 16, 64, 128];

function isTransientRenameError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === 'EACCES' || error.code === 'EPERM';
}

/**
 * Windows refuses a rename with EPERM or EACCES while another writer holds the
 * destination open for its own rename. The collision is transient, so retry
 * before surrendering; POSIX renames just replace and return on the first try.
 */
async function renameInto(temporaryPath: string, filePath: string): Promise<void> {
  for (const delay of RENAME_RETRY_DELAYS_MS) {
    try {
      await rename(temporaryPath, filePath);
      return;
    } catch (error) {
      if (!isTransientRenameError(error)) throw error;
      await Bun.sleep(delay);
    }
  }
  await rename(temporaryPath, filePath);
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

/**
 * Writes through a temporary sibling and renames it into place, so a reader
 * never observes a half-written file. The temporary name is unique per call:
 * two writers racing over the same path — most realistically two processes
 * materializing defaults at startup — must not adopt or delete each other's
 * scratch file.
 */
async function writeJson(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;

  try {
    await mkdir(dirname(filePath), { recursive: true });
    await Bun.write(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
    await renameInto(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new ConfigError('unwritable', filePath, 'could not be written.', error);
  }
}

function parseDocument<T>(
  schema: z.ZodType<T>,
  source: unknown,
  filePath: string,
): ParsedDocument<T> {
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
  document: ParsedDocument<T>,
  logger: Logger,
): Promise<void> {
  if (stableStringify(source) === stableStringify(document.value)) return;

  await writeJson(filePath, document.value);
  logger.info({ added: document.added, path: filePath }, 'Configuration file updated.');
}

export { materialize, parseDocument, readJson, writeJson };

export type { LoaderContext, ParsedDocument };
