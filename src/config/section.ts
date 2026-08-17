import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { ConfigError } from './error';
import { type LoaderContext, materialize, parseDocument, readJson, writeJson } from './loader';

import type { z } from 'zod';

type ConfigApply = 'hot' | 'restart';

interface SectionBase {
  readonly applies: ConfigApply;
  readonly name: string;
}

interface FileSection<T> extends SectionBase {
  readonly kind: 'file';
  load(context: LoaderContext): Promise<T>;
  update(context: LoaderContext, next: unknown): Promise<T>;
}

interface DirectorySection<T> extends SectionBase {
  readonly kind: 'directory';
  deleteEntry(context: LoaderContext, entryId: string): Promise<void>;
  load(context: LoaderContext): Promise<Record<string, T>>;
  update(context: LoaderContext, next: unknown): Promise<Record<string, T>>;
  updateEntry(context: LoaderContext, entryId: string, next: unknown): Promise<T>;
}

type ConfigSection<T = unknown> = DirectorySection<T> | FileSection<T>;

type SectionValue<S> = S extends { load(context: LoaderContext): Promise<infer T> } ? T : never;

interface FileSectionInput<T> {
  applies: ConfigApply;
  materialize?: boolean;
  merge?: (previous: T | undefined, next: T) => T;
  name: string;
  schema: z.ZodType<T>;
}

interface DirectorySectionInput<T> {
  applies: ConfigApply;
  entrySchema: z.ZodType<T>;
  materialize?: boolean;
  name: string;
}

function fileSection<T>(input: FileSectionInput<T>): FileSection<T> {
  const materializes = input.materialize ?? true;

  return {
    applies: input.applies,
    kind: 'file',
    name: input.name,

    async load(context: LoaderContext): Promise<T> {
      const filePath = join(context.configDir, input.name);
      const source = await readJson(filePath);

      if (source === undefined) {
        const document = parseDocument(input.schema, {}, filePath);
        if (materializes) {
          await writeJson(filePath, document.value);
          context.logger.info({ path: filePath }, 'Configuration file generated with defaults.');
        }
        return document.value;
      }

      const document = parseDocument(input.schema, source, filePath);
      if (materializes) {
        await materialize(filePath, source, document, context.logger);
      }
      return document.value;
    },

    async update(context: LoaderContext, next: unknown): Promise<T> {
      const filePath = join(context.configDir, input.name);
      const document = parseDocument(input.schema, next, filePath);

      let value = document.value;
      if (input.merge !== undefined) {
        const source = await readJson(filePath);
        const previous =
          source === undefined ? undefined : parseDocument(input.schema, source, filePath).value;
        value = input.merge(previous, document.value);
      }

      await writeJson(filePath, value);
      return value;
    },
  };
}

function directorySection<T>(input: DirectorySectionInput<T>): DirectorySection<T> {
  const materializes = input.materialize ?? true;

  function unimplemented(context: LoaderContext): ConfigError {
    return new ConfigError(
      'unwritable',
      join(context.configDir, input.name),
      'cannot be written yet: entry writes land with the subsystem that owns them.',
    );
  }

  return {
    applies: input.applies,
    kind: 'directory',
    name: input.name,

    deleteEntry(context: LoaderContext): Promise<void> {
      return Promise.reject(unimplemented(context));
    },

    async load(context: LoaderContext): Promise<Record<string, T>> {
      const dirPath = join(context.configDir, input.name);

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

        const document = parseDocument(input.entrySchema, source, filePath);
        if (materializes) {
          await materialize(filePath, source, document, context.logger);
        }
        result[entry.name.slice(0, -'.json'.length)] = document.value;
      }

      return result;
    },

    update(context: LoaderContext): Promise<Record<string, T>> {
      return Promise.reject(unimplemented(context));
    },

    updateEntry(context: LoaderContext): Promise<T> {
      return Promise.reject(unimplemented(context));
    },
  };
}

export { directorySection, fileSection };

export type {
  ConfigApply,
  ConfigSection,
  DirectorySection,
  DirectorySectionInput,
  FileSection,
  FileSectionInput,
  SectionValue,
};
