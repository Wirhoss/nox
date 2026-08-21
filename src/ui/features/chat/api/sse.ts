import { ApiContractError } from '@/shared/api/http'

import { type ChatEvent, chatEventSchema } from './chat.schemas'

type EventListener = (event: ChatEvent) => void

async function parseChatEventStream(
  stream: ReadableStream<Uint8Array>,
  listener: EventListener,
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
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
  } finally {
    reader.releaseLock()
  }
}

function parseFrame(frame: string, listener: EventListener): void {
  if (frame.length === 0 || frame.startsWith(':')) return

  let eventName: string | undefined
  const data: string[] = []

  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue
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

  listener(parsed.data)
}

export { parseChatEventStream }
