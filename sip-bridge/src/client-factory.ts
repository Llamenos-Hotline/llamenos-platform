import type { BridgeClient } from './bridge-client'
import { PBX_TYPES, type BridgeConfig, type PbxType } from './types'
import { AriClient } from './clients/ari-client'
import { EslClient } from './clients/esl-client'
import { KamailioClient } from './clients/kamailio-client'

/** Protocol names people reach for instead of the PBX name (`ari` is how the dev compose broke). */
const PROTOCOL_NAMES: Record<string, PbxType> = { ari: 'asterisk', esl: 'freeswitch', jsonrpc: 'kamailio' }

/**
 * Validate PBX_TYPE. There is exactly one accepted name per PBX — no aliases —
 * so a config that names the protocol fails at startup, loudly, instead of
 * working in one deployment and not another.
 */
export function parsePbxType(raw: string): PbxType {
  if ((PBX_TYPES as readonly string[]).includes(raw)) return raw as PbxType
  const pbx = PROTOCOL_NAMES[raw.toLowerCase()]
  const hint = pbx ? ` "${raw}" is the protocol, not the PBX — set PBX_TYPE=${pbx}.` : ''
  throw new Error(`Unknown PBX_TYPE: "${raw}". Must be one of: ${PBX_TYPES.join(', ')}.${hint}`)
}

/**
 * Create the appropriate BridgeClient based on the PBX type in config.
 * Each PBX type only uses its relevant env vars — others are ignored.
 */
export function createBridgeClient(config: BridgeConfig): BridgeClient {
  const pbxType: PbxType = config.pbxType
  switch (pbxType) {
    case 'asterisk':
      return new AriClient(config)

    case 'freeswitch':
      return new EslClient({
        host: config.eslHost,
        port: config.eslPort,
        password: config.eslPassword,
        connectionTimeoutMs: config.connectionTimeoutMs,
      })

    case 'kamailio':
      return new KamailioClient({
        jsonrpcUrl: config.kamailioJsonrpcUrl,
      })

    default: {
      const unreachable: never = pbxType
      throw new Error(`Unknown PBX_TYPE: "${String(unreachable)}"`)
    }
  }
}
