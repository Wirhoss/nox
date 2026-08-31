import { ApiConnectionError, ApiContractError } from '@/shared/api/http'

import { chatEventSchema } from './chat.schemas'

import type { ChatEvent } from './chat.schemas'

const STREAM_IDLE_TIMEOUT_MS = 75_000

type EventListener = (event: ChatEvent, eventId?: string) => void

interface ChatEventStreamOptions {
  readonly idleTimeoutMs?: number
}

async function parseChatEventStream(
  stream: ReadableStream<Uint8Array>,
  listener: EventListener,
  options: ChatEventStreamOptions = {},
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await readNext(
        reader,
        options.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS,
      )
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      buffer = buffer.split('\r\n').join('\n')

      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        parseFrame(frame, listener)
        boundary = buffer.indexOf('\n\n')
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {
      // The connection is already unusable; cancellation is best-effort cleanup.
    })
    throw error
  } finally {
    reader.releaseLock()
  }
}

async function readNext(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new ApiConnectionError())
        }, idleTimeoutMs)
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function parseFrame(frame: string, listener: EventListener): void {
  if (frame.length === 0 || frame.startsWith(':')) return

  let eventId: string | undefined
  let eventName: string | undefined
  const data: string[] = []

  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue
    if (line.startsWith('id:')) eventId = line.slice('id:'.length).trimStart()
    if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim()
    if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart())
  }

  if (data.length === 0) return

  let body: unknown
  try {
    body = JSON.parse(data.join('\n')) as unknown
  } catch (error) {
    throw new ApiContractError('Nox sent invalid JSON through the chat stream.', error)
  }

  const parsed = chatEventSchema.safeParse(body)
  if (!parsed.success) {
    throw new ApiContractError('Nox sent an invalid chat event.', parsed.error)
  }
  if (eventName !== undefined && eventName !== parsed.data.type) {
    throw new ApiContractError(
      `Chat event name ${eventName} did not match payload type ${parsed.data.type}.`,
    )
  }

  listener(parsed.data, eventId)
}

export { parseChatEventStream }
