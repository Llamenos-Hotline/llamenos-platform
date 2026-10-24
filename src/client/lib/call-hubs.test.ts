import { describe, it, expect, beforeEach } from 'vitest'
import { rememberCallHub, rememberedCallHub, resolveCallHubId, clearRememberedCallHubs } from './call-hubs'

describe('resolveCallHubId', () => {
  beforeEach(() => clearRememberedCallHubs())

  it('files a call the feed saw on hub B to hub B while hub A is active', () => {
    rememberCallHub('CA-1', 'hub-B')
    expect(resolveCallHubId('CA-1', 'hub-A')).toBe('hub-B')
  })

  it('uses the active hub for a call the feed never saw', () => {
    expect(resolveCallHubId('CA-2', 'hub-A')).toBe('hub-A')
  })

  it('reports no hub scope when the instance has none', () => {
    expect(resolveCallHubId('CA-3', null)).toBeNull()
  })

  it('evicts the oldest call once the registry is full', () => {
    for (let i = 0; i < 501; i++) rememberCallHub(`CA-${i}`, 'hub-B')
    expect(rememberedCallHub('CA-0')).toBeUndefined()
    expect(rememberedCallHub('CA-500')).toBe('hub-B')
  })
})
