import { readFileSync, statSync } from 'node:fs'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { sha1 } from '@noble/hashes/legacy.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import type { TelephonyProviderConfig } from '@shared/types'
import { HMAC_SIP_VOLUNTEER_SECRET } from '@shared/crypto-labels'
import { SipConnectionParams } from './sip-tokens'
import { safeFetch } from '../lib/safe-fetch'
import { validateExternalUrl } from '../lib/ssrf-guard'
import { createLogger } from '../lib/logger'

const logger = createLogger('telephony.registrar')

/**
 * Per-volunteer SIP registrar against the self-hosted Asterisk PBX.
 *
 * `/api/telephony/sip-token` issues REAL per-volunteer credentials: the
 * username is `vol_<pubkey16>` and the secret is derived per volunteer (never
 * the hub's credential). The matching PJSIP objects (auth + aor + endpoint)
 * are provisioned on the PBX through ARI's dynamic config API — the same
 * mechanism, and the same astdb store, as the SIP trunk (#1327).
 *
 * Why this exists at all is documented on `sipCredentialsMayBeIssued`
 * (#1203): every vendor generator returns the hub's SHARED trunk credential,
 * pointed at the vendor's SIP domain. Only infrastructure we run can host a
 * per-volunteer identity without leaking volunteer IPs and presence to a
 * third party.
 */

/** The dialplan context written for volunteer endpoints (asterisk-config/extensions.conf) */
export const VOLUNTEER_DIALPLAN_CONTEXT = 'volunteers-sframe'

/** TURN credentials are minted for this long; clients re-fetch /sip-token to renew. */
export const TURN_CREDENTIAL_TTL_SECONDS = 3_600

/** Registration window the endpoint bounds a client to (seconds, jittered client-side). */
export const REGISTRATION_MAX_EXPIRY_SECONDS = 600

// ---------------------------------------------------------------------------
// Identity + secrets
// ---------------------------------------------------------------------------

/** The SIP username every volunteer registers as: derived from their pubkey, unique per volunteer. */
export function volunteerSipUsername(pubkey: string): string {
  return `vol_${pubkey.slice(0, 16)}`
}

function base64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * The per-volunteer endpoint secret: HMAC-SHA256 of the volunteer's pubkey
 * under a registrar-only server secret, domain-separated
 * (HMAC_SIP_VOLUNTEER_SECRET) so it can never be confused with another HMAC
 * in the system.
 *
 * Deriving (rather than drawing random per issuance) keeps /sip-token
 * idempotent: the same volunteer re-fetches the same credential, so a client
 * re-registering after a PBX restart needs no re-provisioning to authenticate.
 * Revocation is the ARI delete of the volunteer's PJSIP objects — the secret
 * string staying derivable is harmless once nothing on the PBX accepts it.
 * Rotating SIP_REGISTRAR_SECRET rotates every volunteer at once.
 */
export function deriveVolunteerSipSecret(masterSecret: string, pubkey: string): string {
  return base64url(hmac(sha256, utf8ToBytes(masterSecret), utf8ToBytes(`${HMAC_SIP_VOLUNTEER_SECRET}:${pubkey}`)))
}

// ---------------------------------------------------------------------------
// TURN credentials (RFC 8489 §, coturn's time-limited credential scheme)
// ---------------------------------------------------------------------------

export interface TurnCredentials {
  username: string
  credential: string
  /** Unix seconds after which coturn stops honouring these credentials. */
  expiresAt: number
}

/**
 * Time-limited TURN credentials in the shape coturn's `use-auth-secret` mode
 * verifies (the RFC 8489 long-term-credential REST convention): the username
 * carries the expiry (`<expiry>:<user>`) and the credential is
 * base64(HMAC-SHA1(static-auth-secret, username)). A seized credential dies
 * with its expiry, and nothing per-volunteer is stored on the TURN server.
 */
export function mintTurnCredentials(
  turnSecret: string,
  username: string,
  ttlSeconds: number = TURN_CREDENTIAL_TTL_SECONDS,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): TurnCredentials {
  const expiresAt = nowSeconds + ttlSeconds
  const turnUsername = `${expiresAt}:${username}`
  return {
    username: turnUsername,
    credential: btoa(String.fromCharCode(...hmac(sha1, utf8ToBytes(turnSecret), utf8ToBytes(turnUsername)))),
    expiresAt,
  }
}

// ---------------------------------------------------------------------------
// TLS trust anchor for the SIP edge
// ---------------------------------------------------------------------------

/** Env slice naming the SIP edge's public TLS trust anchor. */
export interface SipTlsAnchorEnv {
  /** The anchor inline, PEM. Takes precedence over the file. */
  SIP_TLS_CA_PEM?: string
  /** Path to the anchor, written by the SIP edge's entrypoint. */
  SIP_TLS_CA_FILE?: string
}

/** Refuse anything absurd: a trust anchor is a certificate or two, not a store. */
const MAX_ANCHOR_BYTES = 64 * 1024

const CERTIFICATE_BLOCK = /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]*?-----END CERTIFICATE-----/g
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/

let anchorCache: { key: string; pem: string | undefined } | undefined

/**
 * Keep only the certificate blocks of a PEM.
 *
 * Safe by construction rather than by checking: whatever the operator pointed
 * us at — a bare certificate, a chain, or (by mistake) a combined
 * certificate+key file like the one Asterisk reads — only certificates can
 * leave this function, so private key material cannot reach a client even
 * through a misconfiguration.
 */
function certificatesOnly(pem: string, source: string): string | undefined {
  if (PRIVATE_KEY_BLOCK.test(pem)) {
    logger.error(
      'SIP TLS trust anchor holds private key material — publishing its certificates only. ' +
        'Point this at the certificate/chain, never at the keypair.',
      { source },
    )
  }
  const blocks = pem.match(CERTIFICATE_BLOCK)
  if (!blocks?.length) {
    logger.error('SIP TLS trust anchor contains no certificate — clients will fall back to the device trust store', {
      source,
    })
    return undefined
  }
  return `${blocks.join('\n')}\n`
}

/**
 * The SIP edge's public TLS trust anchor, or undefined when the deployment
 * publishes none.
 *
 * This is what lets a self-hoster run SIP over TLS with a self-signed PBX
 * certificate and still have clients VERIFY it: the anchor rides to the client
 * inside the authenticated `/api/telephony/sip-token` response, over the app's
 * own certificate-pinned HTTPS channel. Trust in the SIP leg therefore derives
 * from the API pin — there is no trust-on-first-use step and no reliance on
 * the device's public CA store for SIP.
 *
 * Undefined means "use the device trust store", which is correct only when the
 * SIP edge serves a publicly-trusted certificate. It never means "skip
 * verification"; clients keep certificate verification on either way.
 *
 * Re-read when the file changes (size or mtime), so regenerating the PBX
 * certificate does not need an app restart.
 */
export function readSipTlsTrustAnchor(env: SipTlsAnchorEnv): string | undefined {
  const inline = env.SIP_TLS_CA_PEM?.trim()
  if (inline) {
    const key = `inline:${inline.length}`
    if (anchorCache?.key !== key) {
      anchorCache = { key, pem: certificatesOnly(inline, 'SIP_TLS_CA_PEM') }
    }
    return anchorCache.pem
  }

  const path = env.SIP_TLS_CA_FILE?.trim()
  if (!path) return undefined

  let key: string
  try {
    const stat = statSync(path)
    if (stat.size > MAX_ANCHOR_BYTES) {
      logger.error('SIP TLS trust anchor is implausibly large — ignoring it', { path, size: stat.size })
      return undefined
    }
    key = `file:${path}:${stat.mtimeMs}:${stat.size}`
  } catch {
    // The edge has not written it yet (first boot ordering), or the path is
    // wrong. Either way: no anchor rather than a stale one.
    logger.warn('SIP TLS trust anchor is not readable — clients will fall back to the device trust store', { path })
    return undefined
  }
  if (anchorCache?.key !== key) {
    try {
      anchorCache = { key, pem: certificatesOnly(readFileSync(path, 'utf8'), path) }
    } catch (err) {
      logger.error('SIP TLS trust anchor could not be read', { path, err })
      return undefined
    }
  }
  return anchorCache.pem
}

// ---------------------------------------------------------------------------
// SIP connection parameters issued to the client
// ---------------------------------------------------------------------------

/**
 * Build the per-volunteer SIP connection parameters for the self-hosted
 * registrar. Asterisk only — every vendor path stays on the refused shared
 * credential (see sipCredentialsMayBeIssued).
 */
export function buildVolunteerSipParams(
  config: TelephonyProviderConfig,
  username: string,
  secret: string,
  turn?: { host: string; credentials: TurnCredentials },
  tlsTrustAnchorPem?: string,
): SipConnectionParams {
  if (config.type !== 'asterisk') {
    throw new Error(`Per-volunteer SIP params are only issuable for provider: asterisk, not ${config.type}`)
  }
  if (!config.sipDomain) {
    throw new Error('Missing Asterisk registrar domain (sipDomain)')
  }

  const iceServers: SipConnectionParams['sip']['iceServers'] = []
  if (turn) {
    iceServers.push({ url: `stun:${turn.host}:3478` })
    iceServers.push({
      url: `turn:${turn.host}:3478?transport=udp`,
      username: turn.credentials.username,
      credential: turn.credentials.credential,
    })
    iceServers.push({
      url: `turn:${turn.host}:3478?transport=tcp`,
      username: turn.credentials.username,
      credential: turn.credentials.credential,
    })
  } else {
    // No TURN server configured: STUN against the registrar's host. The
    // relay-grade path needs TURN_HOST/TURN_SECRET set on the worker.
    iceServers.push({ url: `stun:${config.sipDomain}:3478` })
  }

  return {
    provider: 'asterisk',
    sip: {
      domain: config.sipDomain,
      transport: 'tls',
      username,
      password: secret,
      iceServers,
      mediaEncryption: 'dtls-srtp',
      // The anchor the client verifies the TLS chain against, when the SIP
      // edge does not serve a publicly-trusted certificate. Absent = verify
      // against the device trust store. Never "do not verify".
      ...(tlsTrustAnchorPem ? { tlsTrustAnchorPem } : {}),
    },
  }
}

// ---------------------------------------------------------------------------
// ARI provisioning
// ---------------------------------------------------------------------------

export interface AriCredentials {
  ariUrl: string
  ariUsername: string
  ariPassword: string
}

const VOLUNTEER_OBJECT_TYPES = ['auth', 'aor', 'endpoint'] as const
type VolunteerObjectType = (typeof VOLUNTEER_OBJECT_TYPES)[number]

/** ARI's dynamic config API for the res_pjsip objects of one volunteer endpoint. */
function ariConfigClient(ari: AriCredentials) {
  const headers = { Authorization: `Basic ${btoa(`${ari.ariUsername}:${ari.ariPassword}`)}` }
  const url = (type: VolunteerObjectType, id: string) =>
    `${ari.ariUrl}/ari/asterisk/config/dynamic/res_pjsip/${type}/${encodeURIComponent(id)}`

  return {
    async put(type: VolunteerObjectType, id: string, fields: Record<string, string>): Promise<void> {
      const res = await safeFetch(url(type, id), {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: Object.entries(fields).map(([attribute, value]) => ({ attribute, value })),
        }),
        ssrfGuard: false,
      })
      // The success body echoes every field back, auth passwords included: never read it.
      if (!res.ok) {
        throw new Error(`Asterisk rejected the volunteer endpoint's ${type}: ${res.status}`)
      }
      await res.body?.cancel()
    },

    /** Delete the object if it exists. */
    async remove(type: VolunteerObjectType, id: string): Promise<void> {
      const res = await safeFetch(url(type, id), { method: 'DELETE', headers, ssrfGuard: false })
      if (!res.ok && res.status !== 404) {
        throw new Error(`Asterisk refused to remove the volunteer endpoint's ${type}: ${res.status}`)
      }
      await res.body?.cancel()
    },
  }
}

function requireAri(config: TelephonyProviderConfig): AriCredentials {
  if (config.type !== 'asterisk') throw new Error(`No SIP registrar for provider: ${config.type}`)
  if (!config.ariUrl || !config.ariUsername || !config.ariPassword) {
    throw new Error('Missing Asterisk ARI credentials — cannot reach the registrar')
  }
  const ssrfError = validateExternalUrl(config.ariUrl, 'Asterisk ARI URL')
  if (ssrfError) throw new Error(ssrfError)
  return { ariUrl: config.ariUrl, ariUsername: config.ariUsername, ariPassword: config.ariPassword }
}

/**
 * Provision (idempotently) the PJSIP objects for one volunteer endpoint:
 * auth (userpass against the derived secret), aor (single contact — one
 * device per volunteer, a new registration evicts the stale one), endpoint
 * (inbound auth, volunteer dialplan context, NAT handling, DTLS-SRTP).
 *
 * sorcery.conf backs these objects with astdb on the asterisk-db volume, so
 * a provisioned endpoint survives a PBX restart; contacts stay in memory, so
 * which IP a volunteer registered from never reaches disk (#1207).
 */
export async function provisionVolunteerEndpoint(
  config: TelephonyProviderConfig,
  username: string,
  secret: string,
): Promise<void> {
  const ari = ariConfigClient(requireAri(config))

  await ari.put('auth', username, {
    auth_type: 'userpass',
    username,
    password: secret,
  })
  await ari.put('aor', username, {
    max_contacts: '1',
    remove_existing: 'yes',
    qualify_frequency: '60',
  })
  await ari.put('endpoint', username, {
    // Name-only caller ID round-trips astdb cleanly — a bare name cannot be
    // re-parsed as the number "unknown" (the trunk endpoint documents why).
    callerid: 'Llamenos volunteer',
    context: VOLUNTEER_DIALPLAN_CONTEXT,
    aors: username,
    auth: username,
    disallow: 'all',
    allow: 'ulaw,alaw,opus',
    direct_media: 'no',
    rtp_symmetric: 'yes',
    force_rport: 'yes',
    rewrite_contact: 'yes',
    // The other half of wiring ICE. The client gathers host, server-reflexive
    // and TURN relay candidates from the `iceServers` above; without ICE on
    // the endpoint Asterisk DISCARDS them and falls back to rtp_symmetric
    // alone — which works for many NATs and not for the one this is for. With
    // it, connectivity checks nominate a pair that demonstrably carries
    // packets, and a volunteer behind a symmetric NAT is served by the relay
    // candidate (CoTURN forwards both halves, so no inbound mapping is needed).
    ice_support: 'yes',
    dtmf_mode: 'rfc4733',
    // DTLS-SRTP (RFC 5764), and the client applies what this says rather than
    // hardcoding an algorithm — the pair that could not negotiate in #1188 was
    // a client mandating SDES-SRTP against this.
    //
    // Chosen over SDES-SRTP because SDES carries the media key in the SDP,
    // which the server reads and could log; a DTLS handshake derives it
    // between the endpoints, so the key never appears in signalling.
    //
    // It does NOT make the leg end-to-end: Asterisk terminates DTLS-SRTP, so
    // it holds the media key for this hop and can read the audio. Closing that
    // is SFrame's job (packages/crypto implements the key schedule, and this
    // endpoint's dialplan context is VOLUNTEER_DIALPLAN_CONTEXT —
    // `volunteers-sframe`). SFrame encrypts the RTP PAYLOAD underneath
    // whatever transport protection is in use, so this choice preserves that
    // path rather than foreclosing it — and DTLS-SRTP is the better hop-by-hop
    // layer to put underneath it. The constraint SFrame will add is that the
    // PBX must not transcode an SFrame stream, which means agreeing one
    // pass-through codec on both legs rather than the `ulaw,alaw,opus` set
    // above.
    media_encryption: 'dtls',
    // Without these, `media_encryption: dtls` is inert: Asterisk has no
    // certificate to offer, puts an EMPTY `a=fingerprint:SHA-256` in its SDP
    // answer, and every DTLS handshake the client attempts fails with
    // `tls alert bad certificate`. The call then reaches a running state with
    // no media at all — observed on a live PBX, which is why the e2e asserts
    // the handshake and not just the SDP.
    //
    // Auto-generated rather than pointed at the TLS keypair, deliberately:
    // DTLS-SRTP authenticates the peer by the fingerprint carried in the SDP,
    // which arrived over the TLS-protected signalling channel — the
    // certificate itself needs no CA and no identity, so a per-endpoint
    // ephemeral one is both sufficient and one less file for an operator to
    // place. `dtls_verify: fingerprint` is the matching check on the client's.
    dtls_auto_generate_cert: 'yes',
    dtls_verify: 'fingerprint',
    // `passive`, so the VOLUNTEER's client initiates the DTLS handshake.
    //
    // The active side initiates (RFC 5763 §5), and here the offerer is the
    // volunteer — the side behind the NAT. A handshake that starts there goes
    // outbound and opens the mapping on its way; one the PBX starts has to
    // arrive at a mapping that does not exist yet. `actpass` made Asterisk
    // answer `active` and no media moved at all on a live run; `passive`
    // started it.
    dtls_setup: 'passive',
  })
}

/**
 * Revoke a volunteer's SIP identity: remove the endpoint, its aor and its
 * auth from the PBX. Deleting the objects — not the secret — is the
 * revocation: the derived secret becomes a string nothing accepts. Removal is
 * dependent-objects-first; a 404 counts as already gone.
 */
export async function removeVolunteerEndpoint(
  config: TelephonyProviderConfig,
  username: string,
): Promise<void> {
  const ari = ariConfigClient(requireAri(config))
  for (const type of [...VOLUNTEER_OBJECT_TYPES].reverse() as VolunteerObjectType[]) {
    await ari.remove(type, username)
  }
}

// ---------------------------------------------------------------------------
// Route-facing orchestration
// ---------------------------------------------------------------------------

/** The slice of the service registry the revocation hooks need. */
interface RegistrarServices {
  settings: {
    getTelephonyProvider(hmacSecret?: string): Promise<TelephonyProviderConfig | null>
  }
}

/**
 * Best-effort revocation of one volunteer's SIP identity, for the hooks that
 * already mean "this volunteer must hold nothing": account deletion and loss
 * of the last hub role. A no-op unless the provider is our own Asterisk —
 * vendors were never issued anything to revoke. Failure is logged loudly but
 * never blocks the admin action that triggered it (the identity record is
 * already gone; a leftover endpoint is re-revocable and cannot mint new
 * credentials).
 */
export async function revokeVolunteerSipIdentity(
  services: RegistrarServices,
  hmacSecret: string,
  pubkey: string,
): Promise<void> {
  let config: TelephonyProviderConfig | null = null
  try {
    config = await services.settings.getTelephonyProvider(hmacSecret)
  } catch (err) {
    logger.error('SIP revocation: could not read telephony provider config', { pubkey, err })
    return
  }
  if (config?.type !== 'asterisk') return
  try {
    await removeVolunteerEndpoint(config, volunteerSipUsername(pubkey))
    logger.info('SIP identity revoked', { username: volunteerSipUsername(pubkey) })
  } catch (err) {
    logger.error('SIP revocation: PBX refused to remove the volunteer endpoint', { pubkey, err })
  }
}

/**
 * Endpoint cleanup when the telephony provider configuration moves AWAY from
 * Asterisk: the gate stops issuing immediately, but the provisioned PJSIP
 * objects on the PBX would keep accepting registrations from anyone holding an
 * old credential, so tear them down. Every volunteer username is derivable
 * from the users table, so no bookkeeping store is needed.
 */
export async function removeAllVolunteerEndpoints(
  config: TelephonyProviderConfig,
  pubkeys: string[],
): Promise<{ removed: number; failed: number }> {
  let removed = 0
  let failed = 0
  for (const pubkey of pubkeys) {
    try {
      await removeVolunteerEndpoint(config, volunteerSipUsername(pubkey))
      removed += 1
    } catch (err) {
      failed += 1
      logger.error('SIP cleanup: failed to remove a volunteer endpoint', { pubkey, err })
    }
  }
  return { removed, failed }
}
