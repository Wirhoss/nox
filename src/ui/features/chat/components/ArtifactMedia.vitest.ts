import { fireEvent, render, waitFor } from '@testing-library/vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '@/app/stores/auth.store'
import { authApi } from '@/features/auth/api/auth.api'

import { readArtifact } from '../api/artifact.api'
import { useActiveSessionStore } from '../stores/activeSession.store'
import ArtifactMedia from './ArtifactMedia.vue'

import type { ArtifactRef } from '../api/chat.schemas'

vi.mock('../api/artifact.api', () => ({
  readArtifact: vi.fn<
    (artifactId: string, accessToken: string, conversationId?: string) => Promise<Blob>
  >(),
}))
const readArtifactMock = vi.mocked(readArtifact)

const artifact = (overrides: Partial<ArtifactRef> = {}): ArtifactRef => ({
  artifactId: 'art_test',
  filename: 'report.pdf',
  mediaType: 'application/pdf',
  size: 42,
  ...overrides,
})

let auth: ReturnType<typeof useAuthStore>
let session: ReturnType<typeof useActiveSessionStore>
let objectUrl = 0

beforeEach(async () => {
  vi.clearAllMocks()
  objectUrl = 0
  setActivePinia(createPinia())
  auth = useAuthStore()
  session = useActiveSessionStore()
  vi.spyOn(authApi, 'login').mockResolvedValue({
    accessToken: 'access-token',
    account: { accountId: 'account-1', createdAt: 1, username: 'operator' },
    expiresInSeconds: 3_600,
  })
  await auth.login({ password: 'secret', username: 'operator' })
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn<() => string>(() => `blob:test-${String(++objectUrl)}`),
    revokeObjectURL: vi.fn<(url: string) => void>(),
  })
})

afterEach(() => {
  session.$dispose()
  auth.$dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ArtifactMedia', () => {
  it('does not download a document until the user asks for it', async () => {
    readArtifactMock.mockResolvedValue(new Blob(['document']))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const view = render(ArtifactMedia, {
      props: { part: { artifact: artifact(), type: 'artifact' } },
    })

    expect(readArtifactMock).not.toHaveBeenCalled()
    await fireEvent.click(view.getByRole('button', { name: 'report.pdf' }))

    await waitFor(() => {
      expect(readArtifactMock).toHaveBeenCalledWith(
        'art_test',
        'access-token',
        session.conversationId,
      )
      expect(click).toHaveBeenCalledOnce()
    })
  })

  it('loads audio only when playback is requested', async () => {
    readArtifactMock.mockResolvedValue(new Blob(['audio']))
    const view = render(ArtifactMedia, {
      props: {
        part: {
          artifact: artifact({ filename: 'clip.mp3', mediaType: 'audio/mpeg' }),
          type: 'artifact',
        },
      },
    })

    expect(readArtifactMock).not.toHaveBeenCalled()
    await fireEvent.click(view.getByRole('button', { name: 'clip.mp3' }))

    await waitFor(() => {
      expect(view.container.querySelector('audio')?.getAttribute('src')).toBe('blob:test-1')
    })
    expect(readArtifactMock).toHaveBeenCalledOnce()
  })

  it('loads an image only after its placeholder enters the viewport', async () => {
    let observe: IntersectionObserverCallback | undefined
    const disconnect = vi.fn<() => void>()
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        public constructor(callback: IntersectionObserverCallback) {
          observe = callback
        }

        public disconnect = disconnect
        public observe = vi.fn<(target: Element) => void>()
      },
    )
    readArtifactMock.mockResolvedValue(new Blob(['image']))
    const { container } = render(ArtifactMedia, {
      props: {
        part: {
          artifact: artifact({ filename: 'photo.png', mediaType: 'image/png' }),
          type: 'artifact',
        },
      },
    })

    await waitFor(() => {
      expect(observe).toBeDefined()
    })
    expect(readArtifactMock).not.toHaveBeenCalled()
    observe?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)

    await waitFor(() => {
      expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:test-1')
    })
    expect(readArtifactMock).toHaveBeenCalledOnce()
    expect(disconnect).toHaveBeenCalled()
  })
})
