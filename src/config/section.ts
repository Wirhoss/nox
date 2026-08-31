import type {
  ConfigEntrySummaryDescriptor,
  ConfigInventory,
  ConfigKey,
  ConfigSectionEditor,
  ConfigSectionGroup,
  ContributionPoint,
} from '@nox/extension-api';
import type { z } from 'zod';

type ConfigApply = 'hot' | 'restart';

interface SectionPresentation {
  readonly description: string;
  readonly editor: ConfigSectionEditor;
  readonly entrySummary?: ConfigEntrySummaryDescriptor;
  readonly group: ConfigSectionGroup;
  readonly inventory?: readonly ConfigInventory[];
  readonly label: string;
  readonly plural: string;
  readonly references?: readonly ConfigKey[];
  readonly slug: string;
}

interface SectionBase {
  readonly applies: ConfigApply;
  /** Whether a missing or out-of-date file is written back with resolved defaults. */
  readonly materialize: boolean;
  readonly name: string;
  /** Navigation and editor metadata exported by the same catalog that owns the section. */
  readonly presentation: SectionPresentation;
}

/**
 * Sections are data, not behaviour. Their schema is a readable field so the one
 * module that administers configuration can validate, diff and describe every
 * section without asking the section to do it — and so a surface can enumerate
 * what is configurable at all. Reading and writing lives in the loader.
 */
interface FileSection<T = unknown> extends SectionBase {
  readonly kind: 'file';
  readonly merge?: (previous: T | undefined, next: T) => T;
  readonly schema: z.ZodType<T>;
}

/** A directory of homogeneous entries: one schema, many files. */
interface DirectorySection<T = unknown> extends SectionBase {
  readonly kind: 'directory';
  readonly entrySchema: z.ZodType<T>;
}

/**
 * A section whose entries are configured instances of whatever is registered at
 * a contribution point. Its exact schema cannot be written here, because the set
 * of kinds is not known until extensions have activated: it is built at load
 * time from the `configSchema` each contribution declares.
 *
 * `baseSchema` is the floor every entry provably satisfies — what the point's
 * own contract requires of any config. It types the section statically; the
 * discriminated union assembled from the registry validates it exactly. The
 * static type is deliberately the weaker of the two, because it is the only one
 * that can be written before knowing who contributed.
 */
interface ContributionSection<T = unknown> extends SectionBase {
  readonly kind: 'contribution';
  readonly baseSchema: z.ZodType<T>;
  readonly point: ContributionPoint<unknown>;
}

type ConfigSection<T = unknown> = ContributionSection<T> | DirectorySection<T> | FileSection<T>;

type SectionValue<S> =
  S extends FileSection<infer T>
    ? T
    : S extends DirectorySection<infer T>
      ? Record<string, T>
      : S extends ContributionSection<infer T>
        ? Record<string, T>
        : never;

type SectionInput<S> = Omit<S, 'kind' | 'materialize' | 'presentation'> & {
  materialize?: boolean;
  presentation?: SectionPresentation;
};

const DEFAULT_PRESENTATION = Object.freeze({
  description: 'settings.sections.configuration.description',
  editor: 'json',
  group: 'machine',
  label: 'settings.sections.configuration.label',
  plural: 'settings.sections.configuration.plural',
  slug: 'configuration',
} as const satisfies SectionPresentation);

function fileSection<T>(input: SectionInput<FileSection<T>>): FileSection<T> {
  return Object.freeze({
    ...input,
    kind: 'file',
    materialize: input.materialize ?? true,
    presentation: input.presentation ?? DEFAULT_PRESENTATION,
  });
}

function directorySection<T>(input: SectionInput<DirectorySection<T>>): DirectorySection<T> {
  return Object.freeze({
    ...input,
    kind: 'directory',
    materialize: input.materialize ?? true,
    presentation: input.presentation ?? DEFAULT_PRESENTATION,
  });
}

function contributionSection<T>(
  input: SectionInput<ContributionSection<T>>,
): ContributionSection<T> {
  return Object.freeze({
    ...input,
    kind: 'contribution',
    materialize: input.materialize ?? true,
    presentation: input.presentation ?? DEFAULT_PRESENTATION,
  });
}

export { contributionSection, directorySection, fileSection };

export type {
  ConfigApply,
  ConfigSection,
  ContributionSection,
  DirectorySection,
  FileSection,
  SectionPresentation,
  SectionValue,
};
