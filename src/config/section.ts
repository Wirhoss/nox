import type { z } from 'zod';

type ConfigApply = 'hot' | 'restart';

interface SectionBase {
  key: string;
  name: string;
  applies: ConfigApply;
}

interface FileSection<T = unknown> extends SectionBase {
  kind: 'file';
  schema: z.ZodType<T>;
  merge?: (previous: T, next: T) => T;
}

interface DirectorySection<T = unknown> extends SectionBase {
  kind: 'directory';
  entrySchema: z.ZodType<T>;
  merge?: (previous: T, next: T) => T;
}

type ConfigSection<T = unknown> = DirectorySection<T> | FileSection<T>;

type SectionValue<S> =
  S extends FileSection<infer T> ? T
    : S extends DirectorySection<infer T> ? Record<string, T>
      : never;

function fileSection<T>(section: Omit<FileSection<T>, 'kind'>): FileSection<T> {
  return { ...section, kind: 'file' };
}

function directorySection<T>(
  section: Omit<DirectorySection<T>, 'kind'>,
): DirectorySection<T> {
  return { ...section, kind: 'directory' };
}

export {
  directorySection,
  fileSection,
};

export type {
  ConfigApply,
  ConfigSection,
  DirectorySection,
  FileSection,
  SectionValue,
};
