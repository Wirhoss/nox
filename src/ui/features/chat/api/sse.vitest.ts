import { describe, expect, it } from 'vitest'

import { parseChatEventStream } from './sse'

const encoder = new TextEncoder()

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

describe('chat SSE parser', () => {
  it('ignores heartbeats and validates events split across chunks', async () => {
    const events: unknown[] = []
    const stream = streamOf(
      ': open\n\n',
      'event: fragment\ndata: {"conversationId":"web_1",',
      '"turnId":"run_1","type":"fragment","text":"hel"}\n\n',
      ': ping\n\n',
    )

    await parseChatEventStream(stream, (event) => events.push(event))

    expect(events).toEqual([
      { conversationId: 'web_1', text: 'hel', turnId: 'run_1', type: 'fragment' },
    ])
  })

  it('rejects an SSE name that disagrees with its validated payload', async () => {
    const stream = streamOf(
      'event: message\ndata: {"conversationId":"web_1","turnId":"run_1","type":"error","text":"no"}\n\n',
    )

    await expect(parseChatEventStream(stream, () => undefined)).rejects.toThrow(/did not match/)
  })
})
