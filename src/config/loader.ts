import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { type ContributionReader, isConfigurable } from '../extensions/contribution';
import { diffPaths, stableStringify } from '../utils/json';
import { ConfigError } from './error';

import type { Logger } from '../logger/logger';
import type { ConfigSection, ContributionSection, DirectorySection, FileSection } from './section';

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

/**
 * Instance IDs name a configured instance, not a kind: two entries may both be
 * `openai_completions` and differ only in `baseUrl`. Keeping them separate from
 * the contribution ID is what makes more than one instance of a kind possible.
 */
const instanceIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Use letters, digits, dots, dashes or underscores.');

/**
 * Assembles a contribution section's exact schema from what is registered right
 * now: a record of instance ID to the discriminated union of every declared
 * `configSchema`. This is the only schema in the system that cannot be written
 * down ahead of time, because its alternatives arrive with the extensions.
 */
function contributionSchema<T>(
  section: ContributionSection<T>,
  contributions: ContributionReader,
): z.ZodType<Record<string, T>> {
  const schemas = contributions
    .list(section.point)
    .map((contribution) => contribution.value)
    .filter(isConfigurable)
    .map((value) => value.configSchema);

  const entry =
    schemas.length === 0
      ? z.never({ error: `Nothing is registered at ${section.point.id} to configure.` })
      : z.discriminatedUnion('type', schemas as [(typeof schemas)[number]]);

  // The union is built from values only known at runtime, so its inferred type
  // cannot meet the section's declared floor by inference. It does meet it by
  // construction: the point only accepts contributions whose config extends it.
  return z.record(instanceIdSchema, entry) as unknown as z.ZodType<Record<string, T>>;
}

async function loadFileSection<T>(section: FileSection<T>, context: LoaderContext): Promise<T> {
  return loadDocument(join(context.configDir, section.name), section.schema, section, context);
}

async function loadContributionSection<T>(
  section: ContributionSection<T>,
  context: LoaderContext,
  contributions: ContributionReader,
): Promise<Record<string, T>> {
  const schema = contributionSchema(section, contributions);
  return loadDocument(join(context.configDir, section.name), schema, section, context);
}

/** The read/parse/materialize cycle every single-file section shares. */
async function loadDocument<T>(
  filePath: string,
  schema: z.ZodType<T>,
  section: { materialize: boolean },
  context: LoaderContext,
): Promise<T> {
  const source = await readJson(filePath);

  if (source === undefined) {
    const document = parseDocument(schema, {}, filePath);
    if (section.materialize) {
      await writeJson(filePath, document.value);
      context.logger.info({ path: filePath }, 'Configuration file generated with defaults.');
    }
    return document.value;
  }

  const document = parseDocument(schema, source, filePath);
  if (section.materialize) {
    await materialize(filePath, source, document, context.logger);
  }
  return document.value;
}

async function loadDirectorySection<T>(
  section: DirectorySection<T>,
  context: LoaderContext,
): Promise<Record<string, T>> {
  const dirPath = join(context.configDir, section.name);

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

    const filePath = join(dirPath, entry.name);
    const source = await readJson(filePath);
    if (source === undefined) {
      context.logger.warn({ path: filePath }, 'Configuration file is empty; skipping it.');
      continue;
    }

    const document = parseDocument(section.entrySchema, source, filePath);
    if (section.materialize) {
      await materialize(filePath, source, document, context.logger);
    }
    result[entry.name.slice(0, -'.json'.length)] = document.value;
  }

  return result;
}

/**
 * An entry ID is a file name, so a caller-supplied one reaches the filesystem
 * here and is checked rather than trusted. The alphabet is the one instance IDs
 * use — a blueprint's ID is the agent's name, and there is no reason for two
 * dialects of the same idea — with a length a file name can actually carry.
 */
const entryIdSchema = instanceIdSchema.max(64);

function entryPath(section: DirectorySection, context: LoaderContext, entryId: string): string {
  const directory = join(context.configDir, section.name);
  if (!entryIdSchema.safeParse(entryId).success) {
    throw new ConfigError(
      'unwritable',
      directory,
      `cannot hold an entry named "${entryId}": use up to 64 letters, digits, dots, dashes or ` +
        'underscores, starting with a letter or digit.',
    );
  }
  return join(directory, `${entryId}.json`);
}

/**
 * Writes one entry of a directory section, validated against the same schema
 * that loads it — a file written here and a file edited by hand are the same
 * file, and one accepted through a path the other rejects is a second answer.
 *
 * `validate` runs between parsing and writing, for a check the entry's own
 * schema cannot make because it is about something outside the entry: whether
 * the instances it names are configured. Placing it here rather than in the
 * caller is what keeps an entry that fails it from ever reaching disk.
 */
async function updateEntry<T>(
  section: DirectorySection<T>,
  context: LoaderContext,
  entryId: string,
  next: unknown,
  validate?: (value: T) => Promise<void> | void,
): Promise<T> {
  const filePath = entryPath(section, context, entryId);
  const document = parseDocument(section.entrySchema, next, filePath);

  await validate?.(document.value);
  await writeJson(filePath, document.value);
  context.logger.info({ path: filePath }, 'Configuration entry written.');

  return document.value;
}

/**
 * Removes one entry. `false` when there was no file to remove, which is an
 * answer rather than a failure: the caller asked for it to be gone, and it is.
 */
async function removeEntry(
  section: DirectorySection,
  context: LoaderContext,
  entryId: string,
): Promise<boolean> {
  const filePath = entryPath(section, context, entryId);
  if (!(await Bun.file(filePath).exists())) return false;

  try {
    await rm(filePath, { force: true });
  } catch (error) {
    throw new ConfigError('unwritable', filePath, 'could not be removed.', error);
  }
  context.logger.info({ path: filePath }, 'Configuration entry removed.');

  return true;
}

function loadSection<T>(
  section: ConfigSection<T>,
  context: LoaderContext,
  contributions?: ContributionReader,
): Promise<Record<string, T> | T> {
  switch (section.kind) {
    case 'file':
      return loadFileSection(section, context);
    case 'directory':
      return loadDirectorySection(section, context);
    case 'contribution': {
      if (contributions === undefined) {
        throw new ConfigError(
          'unresolved',
          join(context.configDir, section.name),
          'is backed by a contribution point and needs the registry to build its schema.',
        );
      }
      return loadContributionSection(section, context, contributions);
    }
  }
}

/**
 * Writes a section, validating the whole document against the same schema that
 * loads it. A file section may fold the previous value in through its `merge`,
 * which is how a stored secret survives an update that did not mention it.
 *
 * `validate` sees the parsed document before anything is written, for the checks
 * a schema cannot make because they are about the rest of the configuration.
 * Throwing from it leaves the file exactly as it was — the same guarantee
 * `updateEntry` gives, so a caller writing one entry gets it whichever way the
 * section happens to store entries.
 */
async function updateSection<T>(
  section: ConfigSection<T>,
  context: LoaderContext,
  next: unknown,
  previous: unknown,
  contributions?: ContributionReader,
  validate?: (value: Record<string, T> | T) => Promise<void> | void,
): Promise<Record<string, T> | T> {
  const filePath = join(context.configDir, section.name);

  if (section.kind === 'directory') {
    throw new ConfigError('unwritable', filePath, 'is a directory; update its entries instead.');
  }

  let schema: z.ZodType;
  if (section.kind === 'file') {
    schema = section.schema;
  } else {
    if (contributions === undefined) {
      throw new ConfigError(
        'unresolved',
        filePath,
        'is backed by a contribution point and needs the registry to build its schema.',
      );
    }
    schema = contributionSchema(section, contributions);
  }

  const document = parseDocument(schema, next, filePath);
  const value =
    section.kind === 'file' && section.merge !== undefined
      ? section.merge(previous as T | undefined, document.value as T)
      : document.value;

  await validate?.(value as Record<string, T> | T);
  await writeJson(filePath, value);
  return value as Record<string, T> | T;
}

export {
  contributionSchema,
  entryIdSchema,
  instanceIdSchema,
  loadDirectorySection,
  loadFileSection,
  loadSection,
  materialize,
  parseDocument,
  readJson,
  removeEntry,
  updateEntry,
  updateSection,
  writeJson,
};

export type { LoaderContext, ParsedDocument };
