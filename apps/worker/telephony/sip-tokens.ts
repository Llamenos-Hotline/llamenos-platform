import type { SipTokenResponse } from '@protocol/schemas/webrtc'
import type { TelephonyProviderConfig } from '@shared/types'

/**
 * SIP connection parameters returned to mobile clients.
 * Provider-agnostic — Linphone SDK consumes these directly.
 *
 * `z.infer` of the response schema, NOT a hand-written mirror of it. The two
 * were written independently and disagreed on every field: the schema
 * published a flat shape with `iceServers[].urls` and `encryption` while this
 * returned a nested `sip` object with `iceServers[].url` and
 * `mediaEncryption` (#1190). The schema is what `describeRoute` publishes to
 * OpenAPI and what every client model is written from, so a client written
 * from it could not decode a single real response (#1659, iOS). Deriving
 * makes that disagreement a type error instead of a runtime one.
 *
 * Field documentation lives on the schema — packages/protocol/schemas/webrtc.ts.
 */
export type SipConnectionParams = SipTokenResponse

/**
 * Whether SIP credentials may be issued to a volunteer at all.
 *
 * True for `provider: asterisk` ONLY, and that is the whole point. Every
 * vendor generator below takes `identity` and declares it `_identity` — the
 * credentials returned are the hub's own `sipUsername`/`sipPassword` from its
 * `TelephonyProviderConfig`, which is hub-scoped. So every volunteer in a hub
 * would receive the same credential: the hub's trunk account at the telephony
 * vendor (#1203).
 *
 * Three consequences, in increasing order of seriousness:
 *
 *   1. Per-volunteer revocation is impossible. When a volunteer leaves there
 *      is nothing to revoke; rotating deauthenticates the whole hub including
 *      the trunk.
 *   2. A seized or malicious device holds credentials that can originate
 *      calls billed to the hub.
 *   3. Registration goes to the VENDOR's SIP domain, so the vendor observes
 *      every volunteer's source IP and online/offline pattern — continuous,
 *      passive, invisible. Under a threat model naming nation states and
 *      private hacking firms this is the one that matters.
 *
 * The leak is latent only because no client completes SIP registration
 * (#1188). Finishing that work would activate it, which is why this refuses
 * at the source rather than relying on clients not to ask.
 *
 * Asterisk passes the bar the vendors cannot: registration targets the PBX we
 * run, and the issued credential is a REAL per-volunteer identity —
 * `vol_<pubkey16>` with a derived per-endpoint secret, provisioned on the PBX
 * over ARI (see telephony/registrar.ts) and individually revocable on role
 * loss or account deletion. The vendor generators are untouched and stay
 * unreachable: a per-volunteer credential AT the vendor would still leak (3),
 * so this does not return true when some provider gains per-user credentials
 * — it returns true when registration targets infrastructure we run.
 */
export function sipCredentialsMayBeIssued(config: TelephonyProviderConfig | null): boolean {
  return config?.type === 'asterisk'
}

/**
 * Check whether a provider has SIP endpoints configured for native VoIP clients.
 * All providers support standard SIP — this checks for the necessary credentials.
 */
export function isSipConfigured(config: TelephonyProviderConfig | null): boolean {
  if (!config) return false
  switch (config.type) {
    case 'twilio':
    case 'signalwire':
      // Needs SIP domain + credential list (separate from WebRTC API key)
      return !!(config.accountSid && config.sipDomain && config.sipUsername && config.sipPassword)
    case 'vonage':
      // Vonage requires Asterisk gateway for SIP client registration
      return !!(config.asteriskGateway && config.asteriskSipUsername && config.asteriskSipPassword)
    case 'plivo':
      // Plivo SIP endpoint credentials
      return !!(config.sipEndpointUsername && config.sipEndpointPassword)
    case 'asterisk':
      // Per-volunteer identities are provisioned on OUR OWN PBX over ARI —
      // issuance needs the registrar's public SIP domain plus ARI access to
      // provision the endpoint. The hub-scoped sipUsername/sipPassword are the
      // vendor-style shared credential this path exists to avoid and are NOT
      // required (or used) here.
      return !!(config.sipDomain && config.ariUrl && config.ariUsername && config.ariPassword)
    default:
      return false
  }
}

/**
 * Generate SIP connection parameters for a mobile VoIP client.
 * Returns standardized params that Linphone SDK can consume regardless of provider.
 */
export function generateSipParams(
  config: TelephonyProviderConfig,
  identity: string,
): SipConnectionParams {
  switch (config.type) {
    case 'twilio':
      return generateTwilioSipParams(config, identity)
    case 'signalwire':
      return generateSignalWireSipParams(config, identity)
    case 'vonage':
      return generateVonageSipParams(config, identity)
    case 'plivo':
      return generatePlivoSipParams(config, identity)
    default:
      // asterisk has no branch here deliberately: its issuable credential is
      // the per-volunteer identity from telephony/registrar.ts — never the
      // hub-scoped config this shared-credential generator would return.
      throw new Error(`SIP not supported for provider: ${config.type}`)
  }
}

// --- Per-provider SIP parameter generation ---

function generateTwilioSipParams(
  config: TelephonyProviderConfig,
  _identity: string,
): SipConnectionParams {
  if (!config.sipDomain || !config.sipUsername || !config.sipPassword) {
    throw new Error('Missing Twilio SIP config: sipDomain, sipUsername, sipPassword')
  }

  return {
    provider: 'twilio',
    sip: {
      domain: config.sipDomain,
      transport: 'tls',
      username: config.sipUsername,
      password: config.sipPassword,
      iceServers: [
        { url: 'stun:global.stun.twilio.com:3478' },
      ],
      mediaEncryption: 'srtp',
    },
  }
}

function generateSignalWireSipParams(
  config: TelephonyProviderConfig,
  _identity: string,
): SipConnectionParams {
  if (!config.sipDomain || !config.sipUsername || !config.sipPassword) {
    throw new Error('Missing SignalWire SIP config')
  }

  const space = config.spaceUrl?.replace(/^https?:\/\//, '').replace(/\/$/, '') ?? config.sipDomain
  return {
    provider: 'signalwire',
    sip: {
      domain: space,
      transport: 'tls',
      username: config.sipUsername,
      password: config.sipPassword,
      iceServers: [
        { url: `stun:${space}:3478` },
      ],
      mediaEncryption: 'srtp',
    },
  }
}

function generateVonageSipParams(
  config: TelephonyProviderConfig,
  _identity: string,
): SipConnectionParams {
  // Vonage doesn't support SIP client registration directly.
  // Route through Asterisk as a SIP gateway.
  if (!config.asteriskGateway || !config.asteriskSipUsername || !config.asteriskSipPassword) {
    throw new Error('Missing Vonage→Asterisk gateway config')
  }

  return {
    provider: 'vonage',
    sip: {
      domain: config.asteriskGateway,
      transport: 'tls',
      username: config.asteriskSipUsername,
      password: config.asteriskSipPassword,
      iceServers: [
        { url: `stun:${config.asteriskGateway}:3478` },
      ],
      mediaEncryption: 'zrtp', // Asterisk supports ZRTP
    },
  }
}

function generatePlivoSipParams(
  config: TelephonyProviderConfig,
  _identity: string,
): SipConnectionParams {
  if (!config.sipEndpointUsername || !config.sipEndpointPassword) {
    throw new Error('Missing Plivo SIP endpoint config')
  }

  return {
    provider: 'plivo',
    sip: {
      domain: 'phone.plivo.com',
      transport: 'tls',
      username: config.sipEndpointUsername,
      password: config.sipEndpointPassword,
      iceServers: [
        { url: 'stun:stun.plivo.com:3478' },
      ],
      mediaEncryption: 'srtp',
    },
  }
}
