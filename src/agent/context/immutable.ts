import type {
  Message,
  MessageContent,
} from '../../provider';

const DATE_MUTATOR_NAMES = [
  'setDate', 'setFullYear', 'setHours', 'setMilliseconds', 'setMinutes', 'setMonth',
  'setSeconds', 'setTime', 'setUTCDate', 'setUTCFullYear', 'setUTCHours',
  'setUTCMilliseconds', 'setUTCMinutes', 'setUTCMonth', 'setUTCSeconds',
] as const;

class ImmutableDate extends Date {}

for (const name of DATE_MUTATOR_NAMES) {
  Object.defineProperty(ImmutableDate.prototype, name, {
    value: (): never => {
      throw new TypeError(`Message timestamps are immutable: ${name}() is not available.`);
    },
  });
}

function freezeDate(value: Date): Date {
  return Object.freeze(new ImmutableDate(value.getTime()));
}

function freezeContent(content: readonly MessageContent[]): readonly MessageContent[] {
  return Object.freeze(content.map((part): MessageContent => (
    part.type === 'text'
      ? Object.freeze({ ...part })
      : Object.freeze({ ...part, source: Object.freeze({ ...part.source }) })
  )));
}

function freezeDeep(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (value === null || typeof value !== 'object') return value;

  const existing = seen.get(value);
  if (existing !== undefined) return existing;

  if (value instanceof Date) return freezeDate(value);

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(freezeDeep(item, seen));
    return Object.freeze(copy);
  }

  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    copy[key] = freezeDeep(item, seen);
  }
  return Object.freeze(copy);
}

function freezeVariant(message: Message): Message {
  const base = { ...message, createdAt: freezeDate(message.createdAt) };

  switch (base.role) {
    case 'assistant':
    case 'reasoning':
    case 'user':
      return { ...base, content: freezeContent(base.content) };
    case 'compacted':
      return {
        ...base,
        compactedMessageIds: Object.freeze([...base.compactedMessageIds]),
        content: freezeContent(base.content),
      };
    case 'folded':
      return {
        ...base,
        content: freezeContent(base.content),
        foldedMessageIds: Object.freeze([...base.foldedMessageIds]),
      };
    case 'toolCall':
      return { ...base, arguments: freezeDeep(base.arguments) as Readonly<Record<string, unknown>> };
    case 'toolResponse':
      return { ...base, response: freezeContent(base.response) };
  }
}

function freezeMessage<T extends Message>(message: T): T {
  return Object.freeze(freezeVariant(message)) as T;
}

export {
  freezeMessage,
};
