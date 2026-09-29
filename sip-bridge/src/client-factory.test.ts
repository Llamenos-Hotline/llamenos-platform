import { describe, it, expect } from 'vitest'
import { createBridgeClient, parsePbxType } from './client-factory'
import type { BridgeConfig } from './types'
import { AriClient } from './clients/ari-client'
import { EslClient } from './clients/esl-client'
import { KamailioClient } from './clients/kamailio-client'

const baseConfig: BridgeConfig = {
  pbxType: 'asterisk',
  ariUrl: 'ws://localhost:8088/ari/events',
  ariRestUrl: 'http://localhost:8088/ari',
  ariUsername: 'admin',
  ariPassword: 'secret',
  eslHost: 'localhost',
  eslPort: 8021,
  eslPassword: 'ClueCon',
  kamailioJsonrpcUrl: 'http://localhost:5060/jsonrpc',
  workerWebhookUrl: 'http://worker:3000',
  bridgeSecret: 'test-secret',
  bridgePort: 3000,
  bridgeHost: '0.0.0.0',
  stasisApp: 'llamenos',
  connectionTimeoutMs: 300000,
}

describe('createBridgeClient', () => {
  it('creates AriClient for asterisk', () => {
    const client = createBridgeClient({ ...baseConfig, pbxType: 'asterisk' })
    expect(client).toBeInstanceOf(AriClient)
  })

  it('creates EslClient for freeswitch', () => {
    const client = createBridgeClient({ ...baseConfig, pbxType: 'freeswitch' })
    expect(client).toBeInstanceOf(EslClient)
  })

  it('creates KamailioClient for kamailio', () => {
    const client = createBridgeClient({ ...baseConfig, pbxType: 'kamailio' })
    expect(client).toBeInstanceOf(KamailioClient)
  })

  it('throws for unknown PBX type', () => {
    expect(() =>
      createBridgeClient({ ...baseConfig, pbxType: 'unknown' as BridgeConfig['pbxType'] })
    ).toThrow('Unknown PBX_TYPE')
  })
})

describe('parsePbxType', () => {
  it('accepts each PBX name', () => {
    expect(parsePbxType('asterisk')).toBe('asterisk')
    expect(parsePbxType('freeswitch')).toBe('freeswitch')
    expect(parsePbxType('kamailio')).toBe('kamailio')
  })

  it('rejects the protocol name and says which PBX name to use', () => {
    // docker-compose.dev.yml shipped PBX_TYPE=ari: the bridge crashed on startup.
    expect(() => parsePbxType('ari')).toThrow('set PBX_TYPE=asterisk')
    expect(() => parsePbxType('esl')).toThrow('set PBX_TYPE=freeswitch')
  })

  it('rejects anything else', () => {
    expect(() => parsePbxType('Asterisk ')).toThrow('Unknown PBX_TYPE')
    expect(() => parsePbxType('')).toThrow('Unknown PBX_TYPE')
  })
})
