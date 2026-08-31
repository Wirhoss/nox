/**
 * A form built from the schema the server validates against. Every configurable
 * kind publishes its own JSON Schema, so the editor renders whatever an
 * extension declared — a module added to a capability appears here without this
 * file learning its name.
 *
 * What is understood is a deliberate subset: objects, maps whose keys the
 * operator writes, a `oneOf` of objects discriminated by a constant, scalars,
 * enums, lists, and the credential reference Nox uses everywhere. Anything
 * outside it is left to the JSON surface rather than guessed at, because a form
 * that renders a field it cannot round-trip is worse than no form.
 */

type JsonSchema = Readonly<Record<string, unknown>>

type FieldControl = 'boolean' | 'checklist' | 'enum' | 'list' | 'number' | 'secret' | 'text'

/**
 * A name drawn from something that exists rather than typed from memory. The
 * schema says which catalog a field belongs to, so an editor offers the choice
 * without carrying its own list of which fields name providers and which name
 * models. Unlike an enum, the options are not in the schema — they come from
 * what is configured and what the endpoints report — so the field stays a text
 * field when nothing is known and becomes a choice when something is.
 */
type FieldCatalog = 'model' | 'provider'

const FIELD_CATALOGS: readonly FieldCatalog[] = ['model', 'provider']

interface FieldOption {
  readonly label: string
  readonly messageKey?: string
  readonly value: boolean | number | string
}

interface FieldNode {
  readonly catalog?: FieldCatalog
  readonly control: FieldControl
  readonly default?: unknown
  readonly description?: string
  readonly help?: string
  readonly integer: boolean
  readonly kind: 'field'
  readonly label?: string
  readonly maximum?: number
  readonly minimum?: number
  readonly minItems?: number
  readonly name: string
  readonly options: readonly FieldOption[]
  readonly path: readonly string[]
  readonly required: boolean
  readonly url: boolean
}

interface ObjectNode {
  readonly children: readonly FormNode[]
  readonly help?: string
  readonly kind: 'object'
  readonly label?: string
  readonly name: string
  readonly optional: boolean
  readonly path: readonly string[]
}

/**
 * An object whose keys are written by the operator rather than by the schema:
 * admitted channels by ID, grants by principal, anything else declared as a
 * record. The shape of one *value* is fixed and the keys are the variable part,
 * so children are derived per key by `mapEntryNodes` — a child's path contains
 * the key, and the keys exist only in the value being edited.
 */
interface MapNode {
  /** The schema of one entry's value; `mapEntryNodes` turns it into fields. */
  readonly entry: JsonSchema
  readonly help?: string
  /** What `propertyNames` demands of a key, so a mistyped key is refused where it was typed. */
  readonly keyPattern?: string
  readonly kind: 'map'
  readonly label?: string
  readonly name: string
  readonly optional: boolean
  readonly path: readonly string[]
}

/** A choice between implementations: one constant names which, the rest follows. */
interface VariantNode {
  readonly discriminator: string
  readonly help?: string
  readonly kind: 'variant'
  readonly label?: string
  readonly name: string
  readonly optional: boolean
  readonly path: readonly string[]
  readonly variants: readonly VariantBranch[]
}

interface VariantBranch {
  readonly children: readonly FormNode[]
  readonly value: string
}

/**
 * An array whose entries have a shape rather than a value: model declarations,
 * and anything else written as a list of objects. A sibling of `MapNode` for
 * the same reason — the shape of one entry is fixed and the variable part is
 * how many there are — with the position taking the place of the key.
 */
interface ListNode {
  /** The schema of one entry; `listEntryNodes` turns it into fields. */
  readonly entry: JsonSchema
  readonly help?: string
  readonly kind: 'list'
  readonly label?: string
  readonly name: string
  readonly optional: boolean
  readonly path: readonly string[]
}

type FormNode = FieldNode | ListNode | MapNode | ObjectNode | VariantNode

type ConfigLike = Record<string, unknown>

function isObject(value: unknown): value is ConfigLike {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function schemaOf(value: unknown): JsonSchema | undefined {
  return isObject(value) ? value : undefined
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

/** The `nox` block an extension attached with `.meta()`, if it attached one. */
function meta(schema: JsonSchema): {
  catalog?: FieldCatalog
  help?: string
  label?: string
  options?: Readonly<Record<string, string>>
  secret?: boolean
} {
  const nox = schemaOf(schema.nox)
  if (nox === undefined) return {}
  const options = schemaOf(nox.options)
  const optionLabels =
    options === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(options).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
  const catalog = FIELD_CATALOGS.find((candidate) => candidate === nox.catalog)
  return {
    ...(catalog === undefined ? {} : { catalog }),
    ...(stringOf(nox.help) === undefined ? {} : { help: stringOf(nox.help) }),
    ...(stringOf(nox.label) === undefined ? {} : { label: stringOf(nox.label) }),
    ...(optionLabels === undefined ? {} : { options: optionLabels }),
    ...(nox.secret === true ? { secret: true } : {}),
  }
}

function branches(schema: JsonSchema): readonly JsonSchema[] {
  const candidates = schema.oneOf ?? schema.anyOf
  if (!Array.isArray(candidates)) return []
  return candidates.filter((candidate): candidate is JsonSchema => isObject(candidate))
}

/**
 * The property every branch pins to a different constant — what makes a union a
 * choice rather than a guess. There is no fallback: a union without one is not
 * something this form can edit.
 */
function discriminatorOf(options: readonly JsonSchema[]): string | undefined {
  const first = schemaOf(options[0]?.properties)
  if (first === undefined) return undefined

  return Object.keys(first).find((name) =>
    options.every((option) => {
      const property = schemaOf(schemaOf(option.properties)?.[name])
      return property !== undefined && typeof property.const === 'string'
    }),
  )
}

function constantOf(schema: JsonSchema, name: string): string {
  return stringOf(schemaOf(schemaOf(schema.properties)?.[name])?.const) ?? ''
}

/** Whether an array's items carry structure a comma-separated field would destroy. */
function structured(items: JsonSchema): boolean {
  if (items.type === 'object' || items.properties !== undefined) return true
  return branches(items).some((branch) => branch.type === 'object' || branch.properties !== undefined)
}

/** An enum, whether it was written as one or as a union of constants. */
function optionsOf(
  schema: JsonSchema,
  labels?: Readonly<Record<string, string>>,
): readonly FieldOption[] {
  function optionOf(value: boolean | number | string): FieldOption {
    const label = String(value)
    const messageKey =
      labels === undefined || !Object.keys(labels).includes(label) ? undefined : labels[label]
    return { label, ...(messageKey === undefined ? {} : { messageKey }), value }
  }

  if (Array.isArray(schema.enum)) {
    return schema.enum
      .filter(
        (value): value is boolean | number | string =>
          typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
      )
      .map(optionOf)
  }

  const union = branches(schema)
  if (union.length === 0) return []
  const constants = union.map((option) => option.const)
  if (
    !constants.every(
      (value): value is boolean | number | string =>
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
    )
  ) {
    return []
  }
  return constants.map(optionOf)
}

/**
 * The value schema of a record, or nothing if this object is a plain object.
 * The two are told apart by which half is declared: an object names its
 * properties, a record names what every unnamed property must look like. An
 * object's strictness is `additionalProperties: false`, a boolean and not a
 * schema — reading it through `schemaOf` keeps a strict object from being
 * mistaken for a map of nothing.
 */
function mapEntryOf(schema: JsonSchema): JsonSchema | undefined {
  if (schemaOf(schema.properties) !== undefined) return undefined
  return schemaOf(schema.additionalProperties)
}

function isSecret(schema: JsonSchema): boolean {
  if (meta(schema).secret === true) return true
  return schemaOf(schema.properties)?.$secret !== undefined
}

function fieldNode(
  name: string,
  schema: JsonSchema,
  path: readonly string[],
  required: boolean,
  control: FieldControl,
  options: readonly FieldOption[] = [],
): FieldNode {
  const { catalog, help, label } = meta(schema)
  return {
    ...(catalog === undefined ? {} : { catalog }),
    control,
    ...(schema.default === undefined ? {} : { default: schema.default }),
    ...(stringOf(schema.description) === undefined
      ? {}
      : { description: stringOf(schema.description) }),
    ...(help === undefined ? {} : { help }),
    integer: schema.type === 'integer',
    kind: 'field',
    ...(label === undefined ? {} : { label }),
    ...(numberOf(schema.maximum) === undefined ? {} : { maximum: numberOf(schema.maximum) }),
    ...(numberOf(schema.minimum) === undefined ? {} : { minimum: numberOf(schema.minimum) }),
    ...(numberOf(schema.minItems) === undefined ? {} : { minItems: numberOf(schema.minItems) }),
    name,
    options,
    path,
    required,
    url: schema.format === 'uri',
  }
}

/**
 * A choice between shapes, as a node, or nothing when the schema is not one.
 * Separate from `nodeFor` because a union is not only ever a property: a list
 * or map entry can be one too, and there the node's path is the entry itself.
 */
function variantNode(
  name: string,
  schema: JsonSchema,
  path: readonly string[],
  optional: boolean,
  help?: string,
  label?: string,
): undefined | VariantNode {
  const union = branches(schema)
  const discriminator = union.length > 0 ? discriminatorOf(union) : undefined
  if (discriminator === undefined) return undefined
  return {
    discriminator,
    ...(help === undefined ? {} : { help }),
    kind: 'variant',
    ...(label === undefined ? {} : { label }),
    name,
    optional,
    path,
    variants: union.map((option) => ({
      children: childrenOf(option, path),
      value: constantOf(option, discriminator),
    })),
  }
}

/**
 * The fields of one entry of a list or a map. Not `childrenOf`, which reads
 * `properties` and nothing else: an entry is a value, and a value is not always
 * an object — where it is a choice between shapes, its fields depend on which
 * shape was chosen. The variant is named after its discriminator so the
 * selector reads as what it chooses.
 */
function entryNodes(entry: JsonSchema, path: readonly string[]): readonly FormNode[] {
  const union = branches(entry)
  const discriminator = union.length > 0 ? discriminatorOf(union) : undefined
  if (discriminator === undefined) return childrenOf(entry, path)
  const node = variantNode(discriminator, entry, path, false)
  return node === undefined ? [] : [node]
}

/** One property of an object schema, as whatever it turns out to be. */
function nodeFor(
  name: string,
  schema: JsonSchema,
  parentPath: readonly string[],
  required: boolean,
): FormNode | undefined {
  const path = [...parentPath, name]
  const { help, label, options: optionLabels } = meta(schema)

  const variant = variantNode(name, schema, path, !required, help, label)
  if (variant !== undefined) return variant

  const options = optionsOf(schema, optionLabels)
  if (options.length > 0) return fieldNode(name, schema, path, required, 'enum', options)

  if (schema.type === 'object') {
    if (isSecret(schema)) return fieldNode(name, schema, path, required, 'secret')

    const entry = mapEntryOf(schema)
    if (entry !== undefined) {
      const keyPattern = stringOf(schemaOf(schema.propertyNames)?.pattern)
      return {
        entry,
        ...(help === undefined ? {} : { help }),
        ...(keyPattern === undefined ? {} : { keyPattern }),
        kind: 'map',
        ...(label === undefined ? {} : { label }),
        name,
        optional: !required,
        path,
      }
    }

    return {
      children: childrenOf(schema, path),
      ...(help === undefined ? {} : { help }),
      kind: 'object',
      ...(label === undefined ? {} : { label }),
      name,
      optional: !required,
      path,
    }
  }

  if (schema.type === 'array') {
    const items = schemaOf(schema.items) ?? {}
    const choices = optionsOf(items, optionLabels)
    if (choices.length > 0) return fieldNode(name, schema, path, required, 'checklist', choices)
    // A list of things that are not scalars cannot be commas: rendering it that
    // way printed `[object Object]`, and editing it replaced structured entries
    // with the strings they had been printed as. Its entries have a shape the
    // schema already describes, so they are edited as forms like everything else.
    if (structured(items)) {
      return {
        entry: items,
        ...(help === undefined ? {} : { help }),
        kind: 'list',
        ...(label === undefined ? {} : { label }),
        name,
        optional: !required,
        path,
      }
    }
    return fieldNode(name, schema, path, required, 'list')
  }

  if (schema.type === 'boolean') return fieldNode(name, schema, path, required, 'boolean')
  if (schema.type === 'integer' || schema.type === 'number') {
    return fieldNode(name, schema, path, required, 'number')
  }
  if (schema.type === 'string') return fieldNode(name, schema, path, required, 'text')

  // A constant is the discriminator its own variant already renders, and
  // anything else is a shape this form does not claim to edit.
  return undefined
}

function childrenOf(schema: JsonSchema, path: readonly string[]): readonly FormNode[] {
  const properties = schemaOf(schema.properties)
  if (properties === undefined) return []
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === 'string')
    : []

  return Object.entries(properties).flatMap(([name, property]) => {
    const child = schemaOf(property)
    if (child === undefined) return []
    if (child.const !== undefined && child.enum === undefined) return []
    const node = nodeFor(name, child, path, required.includes(name))
    return node === undefined ? [] : [node]
  })
}

/** The editable shape of one configured entry, minus what the editor frames itself. */
function formNodes(schema: JsonSchema, framed: readonly string[]): readonly FormNode[] {
  return childrenOf(schema, []).filter((node) => !framed.includes(node.name))
}

/** A path segment that can address an array without accepting coercive names such as `01`. */
function arrayIndex(step: string): number | undefined {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(step)) return undefined
  const index = Number(step)
  return Number.isSafeInteger(index) ? index : undefined
}

function valueAt(value: ConfigLike, path: readonly string[]): unknown {
  let current: unknown = value
  for (const step of path) {
    if (Array.isArray(current)) {
      const index = arrayIndex(step)
      if (index === undefined) return undefined
      current = current[index]
      continue
    }
    if (!isObject(current)) return undefined
    current = current[step]
  }
  return current
}

/**
 * Writes through objects and arrays without changing either container's shape.
 * List entry paths use their array position as one segment; treating every
 * segment as an object key would turn an array into `{ "0": ... }` on the first
 * edit and make the row disappear on the next render.
 */
function updatedAt(current: unknown, path: readonly string[], next: unknown): unknown {
  const [step, ...rest] = path
  if (step === undefined) return current

  if (Array.isArray(current)) {
    const index = arrayIndex(step)
    if (index === undefined) return current
    const updated = [...current]
    if (rest.length === 0) {
      if (next === undefined) updated.splice(index, 1)
      else updated[index] = next
      return updated
    }
    updated[index] = updatedAt(current[index], rest, next)
    return updated
  }

  const record = isObject(current) ? current : {}
  if (rest.length === 0) {
    if (next === undefined) {
      return Object.fromEntries(Object.entries(record).filter(([key]) => key !== step))
    }
    return { ...record, [step]: next }
  }
  return { ...record, [step]: updatedAt(record[step], rest, next) }
}

function withValueAt(value: ConfigLike, path: readonly string[], next: unknown): ConfigLike {
  const updated = updatedAt(value, path, next)
  return isObject(updated) ? updated : value
}

/** The value a new entry starts from: every default the schema declared. */
function defaultsFor(nodes: readonly FormNode[]): ConfigLike {
  let value: ConfigLike = {}
  for (const node of nodes) {
    if (node.kind === 'field') {
      if (node.default !== undefined) value = withValueAt(value, node.path, node.default)
      continue
    }
    if (node.kind === 'map') {
      // A map starts empty. Its keys are the operator's to write, so seeding one
      // would be inventing an entry nobody asked for.
      if (!node.optional) value = withValueAt(value, node.path, {})
      continue
    }
    if (node.kind === 'list') {
      // Empty for the same reason: how many entries there are is the operator's
      // answer, and one seeded entry is a claim that there is at least one.
      if (!node.optional) value = withValueAt(value, node.path, [])
      continue
    }
    if (node.optional) continue
    value = withValueAt(value, node.path, seedNode(node))
  }
  return value
}

/**
 * What filling one slot starts as: the chosen implementation, and every default
 * that implementation declared. Switching implementations reseeds rather than
 * keeping what was typed, because the fields of two modules are two different
 * sets and carrying one into the other writes settings nobody chose.
 */
function seedNode(
  node: ListNode | MapNode | ObjectNode | VariantNode,
  chosen?: string,
): ConfigLike | readonly ConfigLike[] {
  // A map fills as the empty record it is: its entries are keyed by names only
  // the operator can supply, so there is no seed to give it beyond the slot.
  if (node.kind === 'map') return {}
  // A list likewise: how many entries there are is the operator's answer.
  if (node.kind === 'list') return []
  if (node.kind === 'object') return branchDefaults(node.children)

  const branch =
    node.variants.find((variant) => variant.value === chosen) ?? node.variants[0]
  if (branch === undefined) return {}
  return { ...branchDefaults(branch.children), [node.discriminator]: branch.value }
}

/** The variant a discriminator path belongs to, so a change of it can reseed. */
function pathStartsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((step, index) => path[index] === step)
}

function variantAt(nodes: readonly FormNode[], path: readonly string[]): undefined | VariantNode {
  for (const node of nodes) {
    if (node.kind === 'field') continue
    if (
      node.kind === 'variant' &&
      [...node.path, node.discriminator].join('.') === path.join('.')
    ) {
      return node
    }

    let children: readonly FormNode[]
    if (node.kind === 'list' || node.kind === 'map') {
      if (!pathStartsWith(path, node.path)) continue
      const entry = path[node.path.length]
      if (entry === undefined) continue
      if (node.kind === 'list') {
        const index = arrayIndex(entry)
        if (index === undefined) continue
        children = listEntryNodes(node, index)
      } else children = mapEntryNodes(node, entry)
    } else {
      children =
        node.kind === 'object'
          ? node.children
          : node.variants.flatMap((variant) => variant.children)
    }
    const found = variantAt(children, path)
    if (found !== undefined) return found
  }
  return undefined
}

function branchDefaults(children: readonly FormNode[]): ConfigLike {
  let value: ConfigLike = {}
  for (const child of children) {
    if (child.kind === 'field') {
      if (child.default !== undefined) value = { ...value, [child.name]: child.default }
      continue
    }
    if (child.optional) continue
    if (child.kind === 'map') value = { ...value, [child.name]: {} }
    else if (child.kind === 'list') value = { ...value, [child.name]: [] }
    else if (child.kind === 'object') {
      value = { ...value, [child.name]: branchDefaults(child.children) }
    } else value = { ...value, [child.name]: seedNode(child) }
  }
  return value
}

/** The fields of one map entry, pathed through the key it is filed under. */
function mapEntryNodes(node: MapNode, key: string): readonly FormNode[] {
  return entryNodes(node.entry, [...node.path, key])
}

function listEntryNodes(node: ListNode, index: number): readonly FormNode[] {
  return entryNodes(node.entry, [...node.path, String(index)])
}

/**
 * What a newly added entry starts as: every default its schema declared, and
 * for a choice between shapes, the first one already chosen. An entry added
 * without its discriminator would render as a selector over nothing.
 */
function entryDefaults(entry: JsonSchema): ConfigLike {
  const [node] = entryNodes(entry, [])
  if (node?.kind === 'variant') return seedNode(node) as ConfigLike
  return branchDefaults(childrenOf(entry, []))
}

function listEntryDefaults(node: ListNode): ConfigLike {
  return entryDefaults(node.entry)
}

/** What a newly added entry starts as: every default its value schema declared. */
function mapEntryDefaults(node: MapNode): ConfigLike {
  return entryDefaults(node.entry)
}

/**
 * One key renamed where it stands.
 *
 * Position is preserved rather than the entry being removed and re-added,
 * because a key is typed one character at a time and an entry that jumped to the
 * end of the list on every keystroke would be unusable. A rename onto a key that
 * already exists returns the record untouched: two entries cannot share a key,
 * and quietly overwriting one of them is the worse of the two answers.
 */
function withRenamedKey(record: ConfigLike, from: string, to: string): ConfigLike {
  if (from === to || Object.keys(record).includes(to)) return record
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => (key === from ? [to, value] : [key, value])),
  )
}

function withoutKey(record: ConfigLike, key: string): ConfigLike {
  return Object.fromEntries(Object.entries(record).filter(([candidate]) => candidate !== key))
}

/** Every field currently on screen, flattened, so validation and secrets can walk it. */
function activeFields(nodes: readonly FormNode[], value: ConfigLike): readonly FieldNode[] {
  return nodes.flatMap((node): readonly FieldNode[] => {
    if (node.kind === 'field') return [node]
    if (node.kind === 'list') {
      const entries = valueAt(value, node.path)
      return Array.isArray(entries)
        ? entries.flatMap((_entry, index) => activeFields(listEntryNodes(node, index), value))
        : []
    }
    const present = valueAt(value, node.path)
    if (!isObject(present)) return []
    if (node.kind === 'object') return activeFields(node.children, value)
    if (node.kind === 'map') {
      return Object.keys(present).flatMap((entryKey) =>
        activeFields(mapEntryNodes(node, entryKey), value),
      )
    }

    const chosen = present[node.discriminator]
    const branch = node.variants.find((variant) => variant.value === chosen)
    return branch === undefined ? [] : activeFields(branch.children, value)
  })
}

export {
  activeFields,
  defaultsFor,
  formNodes,
  isObject,
  listEntryDefaults,
  listEntryNodes,
  mapEntryDefaults,
  mapEntryNodes,
  seedNode,
  valueAt,
  variantAt,
  withoutKey,
  withRenamedKey,
  withValueAt,
}

export type {
  ConfigLike,
  FieldCatalog,
  FieldControl,
  FieldNode,
  FieldOption,
  FormNode,
  JsonSchema,
  ListNode,
  MapNode,
  ObjectNode,
  VariantBranch,
  VariantNode,
}
