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
      'id: 17\nevent: fragment\ndata: {"conversationId":"web_1",',
      '"turnId":"run_1","type":"fragment","text":"hel"}\n\n',
      ': ping\n\n',
    )

    await parseChatEventStream(stream, (event) => events.push(event))

    expect(events).toEqual([
      { conversationId: 'web_1', text: 'hel', turnId: 'run_1', type: 'fragment' },
    ])
  })

  it('passes the event cursor to the listener for reconnects', async () => {
    const cursors: (string | undefined)[] = []
    const stream = streamOf(
      'id: 41\nevent: fragment\ndata: {"conversationId":"web_1","turnId":"run_1","type":"fragment","text":"hello"}\n\n',
    )

    await parseChatEventStream(stream, (_event, eventId) => cursors.push(eventId))

    expect(cursors).toEqual(['41'])
  })

  it('accepts the web broker activity events, including live reasoning', async () => {
    const events: unknown[] = []
    const base = { conversationId: 'web_1', turnId: 'run_1' }
    const payloads = [
      {
        ...base,
        modelId: 'test-model',
        startedAt: '2026-01-01T00:00:00.000Z',
        trigger: 'user',
        type: 'runStarted',
      },
      { ...base, text: 'thinking', type: 'reasoningFragment' },
      { ...base, text: 'settled thought', type: 'reasoning' },
      { ...base, arguments: { path: '/tmp/a' }, name: 'read', trackId: 't1', type: 'toolCall' },
      {
        ...base,
        execution: 'immediate',
        isError: false,
        name: 'read',
        text: 'done',
        trackId: 't1',
        type: 'toolResponse',
      },
      { ...base, attempt: 2, delayMs: 500, text: 'busy', type: 'retry' },
      {
        ...base,
        change: 'compacted',
        replacedMessageIds: ['m1'],
        text: 'summary',
        type: 'contextChange',
      },
      {
        ...base,
        type: 'contextUsage',
        usage: { compactAtTokens: 6_400, contextWindow: 10_000, usedTokens: 3_200 },
      },
      { ...base, type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
      {
        ...base,
        durationMs: 1200,
        status: 'completed',
        type: 'runCompleted',
        usage: { inputTokens: 10, outputTokens: 2 },
      },
    ]
    const stream = streamOf(
      payloads
        .map((payload) => `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`)
        .join(''),
    )

    await parseChatEventStream(stream, (event) => events.push(event))

    expect(events).toHaveLength(payloads.length)
    expect(events.map((event) => (event as { type: string }).type)).toEqual(
      payloads.map((payload) => payload.type),
    )
  })

  it('times out a stream that stops delivering events and heartbeats', async () => {
    const stream = new ReadableStream<Uint8Array>()

    await expect(
      parseChatEventStream(stream, () => undefined, { idleTimeoutMs: 5 }),
    ).rejects.toMatchObject({ name: 'ApiConnectionError' })
  })

  it('rejects an SSE name that disagrees with its validated payload', async () => {
    const stream = streamOf(
      'event: message\ndata: {"conversationId":"web_1","turnId":"run_1","type":"error","text":"no"}\n\n',
    )

    await expect(parseChatEventStream(stream, () => undefined)).rejects.toThrow(/did not match/)
  })
})
