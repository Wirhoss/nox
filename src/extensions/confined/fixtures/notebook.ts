import type {
  Memory,
  MemoryRecallRequest,
  MemoryRecallResult,
  MemoryRecord,
  MemoryRetainRequest,
} from '@nox/extension-api';

/**
 * A memory for the transport tests, kept in a plain array.
 *
 * Two of them, deliberately. `full` has all three optional surfaces; `sparse`
 * has none — because absence is meaningful in this contract, and a proxy that
 * offered surfaces the implementation never wrote would only be caught by a
 * fixture that does not have them.
 */

const retained: MemoryRetainRequest[] = [];
const facts: MemoryRecord[] = [];

function recall(request: MemoryRecallRequest): MemoryRecallResult {
  return {
    memories: facts
      .filter((fact) => fact.text.includes(request.query))
      .map((fact) => ({ id: fact.id, kind: fact.kind, text: fact.text })),
  };
}

const full: Memory = {
  blocks: {
    read: (request) => request.labels.map((label) => ({ label, value: `block:${label}` })),
    write: (request) => ({ label: request.label, value: request.value }),
  },
  editor: {
    forget: (request) => {
      const before = facts.length;
      const index = facts.findIndex((fact) => fact.id === request.id);
      if (index >= 0) facts.splice(index, 1);
      return facts.length !== before;
    },
    search: (request) => facts.filter((fact) => fact.text.includes(request.query)),
    update: (request) => facts.find((fact) => fact.id === request.id),
    write: (request) => {
      const record: MemoryRecord = {
        id: `fact-${String(facts.length + 1)}`,
        kind: request.kind,
        text: request.text,
      };
      facts.push(record);
      return record;
    },
  },
  inspector: {
    episodes: (request) => ({
      entries: [],
      limit: request.limit,
      offset: request.offset,
      total: 0,
    }),
    facts: (request) => ({
      entries: [],
      limit: request.limit,
      offset: request.offset,
      total: facts.length,
    }),
    scopes: () => [],
  },
  recall,
  retain: (request) => {
    retained.push(request);
  },
};

/** No blocks, no editor, no inspector. A memory is allowed to be only this. */
const sparse: Memory = {
  recall,
  retain: () => undefined,
};

export default {
  full: (): Memory => full,
  /** What the far side actually received, so a crossing can be inspected. */
  lastRetained: (): unknown => retained.at(-1),
  /** Whether the dates it received are Dates, which JSON alone cannot carry. */
  retainedDateTypes: (): readonly string[] =>
    retained.map((request) =>
      [
        request.startedAt instanceof Date ? 'Date' : typeof request.startedAt,
        request.completedAt instanceof Date ? 'Date' : typeof request.completedAt,
      ].join(','),
    ),
  sparse: (): Memory => sparse,
};
