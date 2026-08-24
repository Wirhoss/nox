/**
 * A form built from the schema the server validates against.
 *
 * Every configurable kind — a tool set today, anything contributed later —
 * publishes its own JSON Schema, so the editor renders whatever an extension
 * declared instead of carrying a copy of one extension's fields. That is the
 * whole point: a module added to a capability, or a field added to a module,
 * appears here without this file learning its name.
 *
 * What is understood is a deliberate subset: objects, a `oneOf` of objects
 * discriminated by a constant (which is what a choice between implementations
 * looks like), scalars, enums, lists, and the credential reference Nox uses
 * everywhere. Anything outside it is left to the JSON surface rather than
 * guessed at, because a form that renders a field it cannot round-trip is worse
 * than no form.
 */

type JsonSchema = Readonly<Record<string, unknown>>

type FieldControl = 'boolean' | 'enum' | 'list' | 'number' | 'secret' | 'text'

interface FieldOption {
  readonly label: string
  readonly value: boolean | number | string
}

interface FieldNode {
  readonly control: FieldControl
  readonly default?: unknown
  readonly description?: string
  readonly help?: string
  readonly integer: boolean
  readonly kind: 'field'
  readonly label?: string
  readonly maximum?: number
  readonly minimum?: number
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

type FormNode = FieldNode | ObjectNode | VariantNode

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
function meta(schema: JsonSchema): { help?: string; label?: string; secret?: boolean } {
  const nox = schemaOf(schema.nox)
  if (nox === undefined) return {}
  return {
    ...(stringOf(nox.help) === undefined ? {} : { help: stringOf(nox.help) }),
    ...(stringOf(nox.label) === undefined ? {} : { label: stringOf(nox.label) }),
    ...(nox.secret === true ? { secret: true } : {}),
  }
}

function branches(schema: JsonSchema): readonly JsonSchema[] {
  const candidates = schema.oneOf ?? schema.anyOf
  if (!Array.isArray(candidates)) return []
  return candidates.filter((candidate): candidate is JsonSchema => isObject(candidate))
}

/**
 * The property every branch pins to a different constant. It is what makes a
 * union a choice rather than a guess, and there is no fallback: a union without
 * one is not something this form can edit.
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

/** An enum, whether it was written as one or as a union of constants. */
function optionsOf(schema: JsonSchema): readonly FieldOption[] {
  if (Array.isArray(schema.enum)) {
    return schema.enum
      .filter(
        (value): value is boolean | number | string =>
          typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
      )
      .map((value) => ({ label: String(value), value }))
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
  return constants.map((value) => ({ label: String(value), value }))
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
  const { help, label } = meta(schema)
  return {
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
    name,
    options,
    path,
    required,
    url: schema.format === 'uri',
  }
}

/** One property of an object schema, as whatever it turns out to be. */
function nodeFor(
  name: string,
  schema: JsonSchema,
  parentPath: readonly string[],
  required: boolean,
): FormNode | undefined {
  const path = [...parentPath, name]
  const { help, label } = meta(schema)

  const union = branches(schema)
  const discriminator = union.length > 0 ? discriminatorOf(union) : undefined
  if (discriminator !== undefined) {
    return {
      discriminator,
      ...(help === undefined ? {} : { help }),
      kind: 'variant',
      ...(label === undefined ? {} : { label }),
      name,
      optional: !required,
      path,
      variants: union.map((option) => ({
        children: childrenOf(option, path),
        value: constantOf(option, discriminator),
      })),
    }
  }

  const options = optionsOf(schema)
  if (options.length > 0) return fieldNode(name, schema, path, required, 'enum', options)

  if (schema.type === 'object') {
    if (isSecret(schema)) return fieldNode(name, schema, path, required, 'secret')
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
    return fieldNode(name, schema, path, required, 'list', optionsOf(items))
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

function valueAt(value: ConfigLike, path: readonly string[]): unknown {
  let current: unknown = value
  for (const step of path) {
    if (!isObject(current)) return undefined
    current = current[step]
  }
  return current
}

function withValueAt(value: ConfigLike, path: readonly string[], next: unknown): ConfigLike {
  const [step, ...rest] = path
  if (step === undefined) return value
  if (rest.length === 0) {
    if (next === undefined) {
      return Object.fromEntries(Object.entries(value).filter(([key]) => key !== step))
    }
    return { ...value, [step]: next }
  }

  const child = value[step]
  return { ...value, [step]: withValueAt(isObject(child) ? child : {}, rest, next) }
}

/** The value a new entry starts from: every default the schema declared. */
function defaultsFor(nodes: readonly FormNode[]): ConfigLike {
  let value: ConfigLike = {}
  for (const node of nodes) {
    if (node.kind === 'field') {
      if (node.default !== undefined) value = withValueAt(value, node.path, node.default)
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
function seedNode(node: ObjectNode | VariantNode, chosen?: string): ConfigLike {
  if (node.kind === 'object') return branchDefaults(node.children)

  const branch =
    node.variants.find((variant) => variant.value === chosen) ?? node.variants[0]
  if (branch === undefined) return {}
  return { ...branchDefaults(branch.children), [node.discriminator]: branch.value }
}

/** The variant a discriminator path belongs to, so a change of it can reseed. */
function variantAt(nodes: readonly FormNode[], path: readonly string[]): undefined | VariantNode {
  for (const node of nodes) {
    if (node.kind === 'field') continue
    if (
      node.kind === 'variant' &&
      [...node.path, node.discriminator].join('.') === path.join('.')
    ) {
      return node
    }
    const children =
      node.kind === 'object'
        ? node.children
        : node.variants.flatMap((variant) => variant.children)
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
    if (child.kind === 'object' && !child.optional) {
      value = { ...value, [child.name]: branchDefaults(child.children) }
    }
  }
  return value
}

/** Every field currently on screen, flattened, so validation and secrets can walk it. */
function activeFields(nodes: readonly FormNode[], value: ConfigLike): readonly FieldNode[] {
  return nodes.flatMap((node): readonly FieldNode[] => {
    if (node.kind === 'field') return [node]
    const present = valueAt(value, node.path)
    if (!isObject(present)) return []
    if (node.kind === 'object') return activeFields(node.children, value)

    const chosen = present[node.discriminator]
    const branch = node.variants.find((variant) => variant.value === chosen)
    return branch === undefined ? [] : activeFields(branch.children, value)
  })
}

export { activeFields, defaultsFor, formNodes, isObject, seedNode, valueAt, variantAt, withValueAt }

export type { ConfigLike, FieldControl, FieldNode, FieldOption, FormNode, JsonSchema, ObjectNode, VariantBranch, VariantNode }
