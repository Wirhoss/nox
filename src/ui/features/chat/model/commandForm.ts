type JsonSchema = Readonly<Record<string, unknown>>
type JsonObject = Record<string, unknown>

interface CommandField {
  readonly name: string
  readonly required: boolean
  readonly schema: JsonSchema
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function schemaOf(value: unknown): JsonSchema | undefined {
  return isObject(value) ? value : undefined
}

function typeOf(schema: JsonSchema): string | undefined {
  const declared = schema.type
  if (typeof declared === 'string') return declared
  if (!Array.isArray(declared)) return undefined
  return declared.find((candidate): candidate is string => candidate !== 'null' && typeof candidate === 'string')
}

function fieldsOf(schema: JsonSchema): readonly CommandField[] {
  const properties = schemaOf(schema.properties)
  if (properties === undefined) return []
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === 'string')
      : [],
  )
  return Object.entries(properties).flatMap(([name, candidate]) => {
    const property = schemaOf(candidate)
    return property === undefined ? [] : [{ name, required: required.has(name), schema: property }]
  })
}

function optionsOf(schema: JsonSchema): readonly unknown[] {
  if (Array.isArray(schema.enum)) return schema.enum
  const variants = schema.oneOf ?? schema.anyOf
  if (!Array.isArray(variants)) return []
  const constants = variants.flatMap((candidate) => {
    const option = schemaOf(candidate)
    return option?.const === undefined ? [] : [option.const]
  })
  return constants.length === variants.length ? constants : []
}

function defaultFor(schema: JsonSchema): unknown {
  if (schema.default !== undefined) return structuredClone(schema.default)
  if (schema.const !== undefined) return structuredClone(schema.const)
  const options = optionsOf(schema)
  if (options[0] !== undefined) return structuredClone(options[0])

  switch (typeOf(schema)) {
    case 'array':
      return []
    case 'boolean':
      return false
    case 'integer':
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 0
    case 'object': {
      const value: JsonObject = {}
      for (const field of fieldsOf(schema)) {
        if (field.required || field.schema.default !== undefined) {
          value[field.name] = defaultFor(field.schema)
        }
      }
      return value
    }
    case 'string':
      return ''
    case undefined:
      return undefined
    default:
      return undefined
  }
}

function seedArguments(schema: JsonSchema): JsonObject {
  const seeded = defaultFor(schema)
  return isObject(seeded) ? seeded : {}
}

function itemSchema(schema: JsonSchema): JsonSchema {
  return schemaOf(schema.items) ?? {}
}

function parseInput(value: string, schema: JsonSchema): unknown {
  if (value.length === 0) return undefined
  if (typeOf(schema) === 'integer' || typeOf(schema) === 'number') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : value
  }
  return value
}

export {
  defaultFor,
  fieldsOf,
  isObject,
  itemSchema,
  optionsOf,
  parseInput,
  schemaOf,
  seedArguments,
  typeOf,
}

export type { CommandField, JsonObject, JsonSchema }
