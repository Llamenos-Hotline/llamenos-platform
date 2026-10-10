import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { KamailioClient } from './kamailio-client'

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const original = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    return Promise.resolve(handler(url, init))
  }) as typeof fetch
  return original
}

function mockFetchReject(error: Error) {
  const original = globalThis.fetch
  globalThis.fetch = ((_input: string | URL | Request, _init?: RequestInit) => Promise.reject(error)) as typeof fetch
  return original
}

function jsonRpcResponse<T>(result: T): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id: 1, result }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

function jsonRpcError(code: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

describe('KamailioClient', () => {
  let client: KamailioClient
  let originalFetch: typeof fetch

  beforeEach(() => {
    client = new KamailioClient({ jsonrpcUrl: 'http://kamailio:5060/jsonrpc' })
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  describe('call-control methods throw', () => {
    it('originate throws', async () => {
      await expect(client.originate({ endpoint: 'sip:test' })).rejects.toThrow('SIP proxy')
    })

    it('hangup throws', async () => {
      await expect(client.hangup('ch-1')).rejects.toThrow('SIP proxy')
    })

    it('answer throws', async () => {
      await expect(client.answer('ch-1')).rejects.toThrow('SIP proxy')
    })

    it('bridge throws', async () => {
      await expect(client.bridge('ch-1', 'ch-2')).rejects.toThrow('SIP proxy')
    })

    it('playMedia throws', async () => {
      await expect(client.playMedia('ch-1', 'sound:beep')).rejects.toThrow('SIP proxy')
    })

    it('recordChannel throws', async () => {
      await expect(client.recordChannel('ch-1', { name: 'test' })).rejects.toThrow('SIP proxy')
    })

    it('recordBridge throws', async () => {
      await expect(client.recordBridge('br-1', { name: 'test' })).rejects.toThrow('SIP proxy')
    })

    it('listChannels throws', async () => {
      await expect(client.listChannels()).rejects.toThrow('SIP proxy')
    })

    it('listBridges throws', async () => {
      await expect(client.listBridges()).rejects.toThrow('SIP proxy')
    })
  })

  describe('lifecycle', () => {
    it('isConnected returns true (HTTP is stateless)', () => {
      expect(client.isConnected()).toBe(true)
    })

    it('disconnect is a no-op', () => {
      expect(() => client.disconnect()).not.toThrow()
    })

    it('onEvent is a no-op', () => {
      expect(() => client.onEvent(() => {})).not.toThrow()
    })

    it('offEvent is a no-op', () => {
      expect(() => client.offEvent(() => {})).not.toThrow()
    })
  })

  describe('healthCheck', () => {
    it('returns ok when JSONRPC responds', async () => {
      mockFetch(() => jsonRpcResponse({ version: 'kamailio 5.7.0' }))

      const health = await client.healthCheck()
      expect(health.ok).toBe(true)
      expect(health.details?.version).toBe('kamailio 5.7.0')
      expect(health.latencyMs).toBeGreaterThanOrEqual(0)
    })

    it('returns not-ok on fetch error', async () => {
      mockFetchReject(new Error('connection refused'))

      const health = await client.healthCheck()
      expect(health.ok).toBe(false)
    })

    it('returns not-ok on JSONRPC error', async () => {
      mockFetch(() => jsonRpcError(-32601, 'Method not found'))

      const health = await client.healthCheck()
      expect(health.ok).toBe(false)
    })
  })

  describe('getDispatchers', () => {
    it('parses dispatcher list response', async () => {
      mockFetch(() =>
        jsonRpcResponse({
          RECORDS: [
            {
              SET: {
                ID: 1,
                TARGETS: [
                  { DEST: { URI: 'sip:10.0.0.1:5060', FLAGS: 'AP', PRIORITY: 0 } },
                  { DEST: { URI: 'sip:10.0.0.2:5060', FLAGS: 'IP', PRIORITY: 1 } },
                ],
              },
            },
          ],
        })
      )

      const entries = await client.getDispatchers()
      expect(entries).toHaveLength(2)
      expect(entries[0].uri).toBe('sip:10.0.0.1:5060')
      expect(entries[0].flags).toBe('AP')
      expect(entries[1].priority).toBe(1)
    })

    it('returns empty array when no matching set', async () => {
      mockFetch(() =>
        jsonRpcResponse({
          RECORDS: [
            { SET: { ID: 99, TARGETS: [{ DEST: { URI: 'sip:x', FLAGS: 'AP', PRIORITY: 0 } }] } },
          ],
        })
      )

      const entries = await client.getDispatchers()
      expect(entries).toHaveLength(0)
    })
  })

  describe('setDispatcherState', () => {
    it('sends state code 0 (active) for the configured set, scoped to the given URI', async () => {
      let sentBody: { method: string; params: unknown[] } | undefined
      mockFetch((_url, init) => {
        sentBody = JSON.parse(String(init?.body))
        return jsonRpcResponse(null)
      })

      await client.setDispatcherState('sip:10.0.0.1:5060', 'active')

      expect(sentBody?.method).toBe('dispatcher.set_state')
      expect(sentBody?.params).toEqual([0, 1, 'sip:10.0.0.1:5060'])
    })

    it('sends state code 1 (inactive)', async () => {
      let sentBody: { params: unknown[] } | undefined
      mockFetch((_url, init) => {
        sentBody = JSON.parse(String(init?.body))
        return jsonRpcResponse(null)
      })

      await client.setDispatcherState('sip:10.0.0.1:5060', 'inactive')

      expect(sentBody?.params).toEqual([1, 1, 'sip:10.0.0.1:5060'])
    })

    it('scopes set_state to a non-default dispatcher set', async () => {
      const scoped = new KamailioClient({ jsonrpcUrl: 'http://kamailio:5060/jsonrpc', dispatcherSetId: 7 })
      let sentBody: { params: unknown[] } | undefined
      mockFetch((_url, init) => {
        sentBody = JSON.parse(String(init?.body))
        return jsonRpcResponse(null)
      })

      await scoped.setDispatcherState('sip:10.0.0.1:5060', 'active')

      expect(sentBody?.params).toEqual([0, 7, 'sip:10.0.0.1:5060'])
    })

    it('propagates a JSONRPC error (e.g. unknown URI)', async () => {
      mockFetch(() => jsonRpcError(-32000, 'target not found'))

      await expect(client.setDispatcherState('sip:unknown:5060', 'active')).rejects.toThrow(
        'target not found',
      )
    })
  })

  describe('reloadDispatchers', () => {
    it('calls dispatcher.reload with no params', async () => {
      let sentBody: { method: string; params: unknown[] } | undefined
      mockFetch((_url, init) => {
        sentBody = JSON.parse(String(init?.body))
        return jsonRpcResponse(null)
      })

      await client.reloadDispatchers()

      expect(sentBody?.method).toBe('dispatcher.reload')
      expect(sentBody?.params).toEqual([])
    })
  })

  describe('connect', () => {
    it('succeeds when health check passes', async () => {
      mockFetch(() => jsonRpcResponse({ version: '5.7' }))

      await expect(client.connect()).resolves.toBeUndefined()
    })

    it('throws when health check fails', async () => {
      mockFetchReject(new Error('connection refused'))

      await expect(client.connect()).rejects.toThrow('Cannot connect')
    })
  })
})
