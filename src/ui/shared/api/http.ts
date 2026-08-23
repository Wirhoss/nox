import { z } from 'zod'

const API_PREFIX = '/api'
const errorResponseSchema = z.object({
  detail: z.string().optional(),
  error: z.string(),
  problems: z.array(z.string()).optional(),
  reasons: z.array(z.string()).optional(),
})

type ApiErrorDetails = z.infer<typeof errorResponseSchema>

class ApiError extends Error {
  public readonly code: string | undefined
  public readonly detail: string | undefined
  public readonly problems: readonly string[]
  public readonly reasons: readonly string[]
  public readonly status: number

  constructor(status: number, details?: ApiErrorDetails) {
    super(details?.detail ?? `Nox API request failed with status ${String(status)}.`)
    this.name = 'ApiError'
    this.code = details?.error
    this.detail = details?.detail
    this.problems = details?.problems ?? []
    this.reasons = details?.reasons ?? []
    this.status = status
  }
}

class ApiContractError extends Error {
  public readonly cause: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'ApiContractError'
    this.cause = cause
  }
}

class ApiConnectionError extends Error {
  public readonly cause: unknown

  constructor(cause?: unknown) {
    super('The Nox node could not be reached.')
    this.name = 'ApiConnectionError'
    this.cause = cause
  }
}

async function requestJson<Output>(
  path: string,
  schema: z.ZodType<Output>,
  init: RequestInit = {},
): Promise<Output> {
  const response = await request(path, init)
  const body = await readJson(response)

  if (!response.ok) {
    const parsedError = errorResponseSchema.safeParse(body)
    throw new ApiError(response.status, parsedError.success ? parsedError.data : undefined)
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new ApiContractError(`Nox returned an invalid response for ${path}.`, parsed.error)
  }
  return parsed.data
}

async function requestEmpty(path: string, init: RequestInit = {}): Promise<void> {
  const response = await request(path, init)
  if (response.ok) return

  const body = await readJson(response)
  const parsedError = errorResponseSchema.safeParse(body)
  throw new ApiError(response.status, parsedError.success ? parsedError.data : undefined)
}

async function requestStream(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await request(path, init)
  if (response.ok) return response

  const body = await readJson(response)
  const parsedError = errorResponseSchema.safeParse(body)
  throw new ApiError(response.status, parsedError.success ? parsedError.data : undefined)
}

async function request(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers)
  if (
    init.body !== undefined &&
    !(init.body instanceof FormData) &&
    !headers.has('content-type')
  ) {
    headers.set('content-type', 'application/json')
  }

  try {
    return await fetch(new URL(`${API_PREFIX}${path}`, window.location.origin), {
      ...init,
      credentials: 'include',
      headers,
    })
  } catch (error) {
    if (init.signal?.aborted === true) throw error
    throw new ApiConnectionError(error)
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length === 0) return undefined

  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new ApiContractError('Nox returned a response that was not valid JSON.', error)
  }
}

export {
  ApiConnectionError,
  ApiContractError,
  ApiError,
  requestEmpty,
  requestJson,
  requestStream,
}
