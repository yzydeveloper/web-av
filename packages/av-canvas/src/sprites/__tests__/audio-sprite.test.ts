import { createObjectURLMock, revokeObjectURLMock } from '../../__tests__/mock'
import { beforeEach, expect, test } from 'vitest'
import { AudioSprite } from '../audio-sprite'

beforeEach(() => {
  createObjectURLMock.mockReset()
  revokeObjectURLMock.mockReset()
})

test('create AudioSprite', () => {
  createObjectURLMock.mockReturnValueOnce('mock-audio-src')
  const as = new AudioSprite(
    'as',
    { type: 'audio/mpeg' } as unknown as File,
    { audioCtx: new AudioContext() }
  )
  expect(as.audioNode).not.toBeNull()

  expect(createObjectURLMock).toBeCalledTimes(1)

  as.destroy()
  expect(as.audioNode?.disconnect).toBeCalledTimes(1)
  expect(revokeObjectURLMock).toBeCalledWith(
    expect.stringMatching(/mock-audio-src$/)
  )
})
