import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { sha1 } from '@noble/hashes/legacy.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import type { TelephonyProviderConfig } from '@shared/types'
import { hasAnyHubAccess, type Role } from '@shared/permissions'
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
 * The security-event type whose count is a volunteer's SIP credential epoch
 * (see `deriveVolunteerSipSecret` and `sipCredentialEpoch`).
 */
export const SIP_REVOCATION_EVENT = 'sipIdentityRevoked'

/**
 * The per-volunteer endpoint secret: HMAC-SHA256 of the volunteer's SIP
 * username under a registrar-only server secret, domain-separated
 * (HMAC_SIP_VOLUNTEER_SECRET) so it can never be confused with another HMAC
 * in the system.
 *
 * Deriving (rather than drawing random per issuance) keeps /sip-token
 * idempotent: the same volunteer re-fetches the same credential, so a client
 * re-registering after a PBX restart needs no re-provisioning to authenticate.
 * Revocation is the ARI delete of the volunteer's PJSIP objects — the secret
 * string staying derivable is harmless once nothing on the PBX accepts it.
 * Rotating SIP_REGISTRAR_SECRET rotates every volunteer at once.
 *
 * `epoch` is how many times this volunteer's identity has already been
 * revoked. It keeps determinism *between* revocations while making
 * re-admission issue a credential the volunteer has never held: a secret that
 * leaked while they were out of the hub is not resurrected by letting them
 * back in. Epoch 0 — a volunteer who has never been revoked — is the bare
 * `label:username` message, so the first-issuance derivation is unchanged.
 */
export function deriveVolunteerSipSecret(masterSecret: string, username: string, epoch = 0): string {
  const message = epoch > 0
    ? `${HMAC_SIP_VOLUNTEER_SECRET}:${username}:${epoch}`
    : `${HMAC_SIP_VOLUNTEER_SECRET}:${username}`
  return base64url(hmac(sha256, utf8ToBytes(masterSecret), utf8ToBytes(message)))
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
    dtmf_mode: 'rfc4733',
    media_encryption: 'dtls',
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

/** The slice of the service registry the registrar hooks need. */
export interface RegistrarServices {
  settings: {
    getTelephonyProvider(hmacSecret?: string): Promise<TelephonyProviderConfig | null>
  }
  identity?: {
    getUserInternal(pubkey: string): Promise<{ roles: string[]; hubRoles?: { hubId: string; roleIds: string[] }[] } | null>
    emitSecurityEvent(
      userPubkey: string | null,
      eventType: string,
      deviceId: string | null,
      metadata?: Record<string, unknown>,
    ): Promise<void>
    countSecurityEvents(pubkey: string, eventType: string): Promise<number>
  }
}

/**
 * This volunteer's credential epoch: the number of times their SIP identity
 * has been revoked. Read from the append-only security-event log, so no
 * column has to carry it and the history is auditable. A registry without the
 * identity service (unit fixtures, the provider-switch cleanup) reads 0 —
 * the pre-revocation derivation.
 */
export async function sipCredentialEpoch(services: RegistrarServices, pubkey: string): Promise<number> {
  if (!services.identity) return 0
  try {
    return await services.identity.countSecurityEvents(pubkey, SIP_REVOCATION_EVENT)
  } catch (err) {
    // Reading the epoch must not deny a legitimate volunteer their
    // credential; the worst case is re-issuing the credential they already
    // hold, which is the pre-#1540 behaviour.
    logger.error('SIP epoch unreadable — issuing at epoch 0', { pubkey, err })
    return 0
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
  const username = volunteerSipUsername(pubkey)
  // Advance the epoch FIRST, and whether or not the PBX cooperates: a delete
  // that failed leaves the old secret live on the PBX, and the bumped epoch is
  // what makes the next issuance overwrite it with a credential the holder of
  // the old one does not have.
  await recordSipRevocation(services, pubkey, username)
  try {
    await removeVolunteerEndpoint(config, username)
    logger.info('SIP identity revoked', { username })
  } catch (err) {
    logger.error('SIP revocation: PBX refused to remove the volunteer endpoint', { pubkey, err })
  }
}

/**
 * Append the revocation to the security-event log — the volunteer's credential
 * epoch (see `sipCredentialEpoch`) and an admin-visible record of the
 * teardown.
 *
 * `userPubkey` is deliberately null and the pubkey lives in the metadata:
 * account deletion revokes as the user row goes away, where the FK would
 * either refuse the insert or null the column out from under the count.
 */
async function recordSipRevocation(
  services: RegistrarServices,
  pubkey: string,
  username: string,
): Promise<void> {
  if (!services.identity) return
  try {
    await services.identity.emitSecurityEvent(null, SIP_REVOCATION_EVENT, null, { pubkey, username })
  } catch (err) {
    logger.error('SIP revocation: could not record the revocation event', { pubkey, err })
  }
}

/**
 * Revoke this volunteer's SIP identity if the role change that just happened
 * left them with no hub role anywhere — the single rule every member-removal
 * and role-stripping path calls, so none of them carries its own copy.
 *
 * The predicate is `hasAnyHubAccess`, the same one `/sip-token` issues under
 * (via callerHasAnyHubAccess), so "may no longer be issued" and "must be torn
 * down" are one decision. A user row that is already gone counts as holding
 * nothing, and unreadable roles fail SAFE — revoke: a member wrongly stripped
 * of SIP re-provisions on their next /sip-token; a credential left live at the
 * PBX does not come back on its own.
 */
export async function revokeSipIdentityIfRoleless(
  services: RegistrarServices,
  hmacSecret: string,
  pubkey: string,
  allRoles: Role[],
): Promise<void> {
  let stillHasAccess = false
  try {
    const remaining = await services.identity?.getUserInternal(pubkey)
    stillHasAccess = remaining
      ? hasAnyHubAccess(remaining.roles ?? [], remaining.hubRoles ?? [], allRoles)
      : false
  } catch (err) {
    logger.warn('SIP revocation: remaining roles unreadable — revoking', { pubkey, err })
  }
  if (stillHasAccess) return
  await revokeVolunteerSipIdentity(services, hmacSecret, pubkey)
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
