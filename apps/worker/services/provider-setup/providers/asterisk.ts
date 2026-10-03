import type {
  OwnedNumber,
  AvailableNumber,
} from '@protocol/schemas/provider-setup'
import type { ProviderCapabilityImpl, ConnectionTestResult, SipTrunkConfig, SipTrunkRequest } from '../types'
import { ProviderApiError } from '../types'
import { validateExternalUrl } from '../../../lib/ssrf-guard'
import { safeFetch } from '../../../lib/safe-fetch'

export const asteriskProvider: ProviderCapabilityImpl = {
  providerType: 'asterisk',
  capabilities: ['sipTrunks'],

  async testConnection(credentials: Record<string, unknown>): Promise<ConnectionTestResult> {
    const ariUrl = String(credentials.ariUrl ?? '')
    const ariUsername = String(credentials.ariUsername ?? '')
    const ariPassword = String(credentials.ariPassword ?? '')
    const ssrfError = validateExternalUrl(ariUrl, 'Asterisk ARI URL')
    if (ssrfError) {
      return { connected: false, latencyMs: 0, error: ssrfError, errorType: 'unknown' }
    }
    const start = Date.now()
    try {
      const res = await safeFetch(`${ariUrl}/ari/asterisk/info`, {
        headers: {
          Authorization: `Basic ${btoa(`${ariUsername}:${ariPassword}`)}`,
        },
        ssrfGuard: false,
      })
      if (!res.ok) {
        await res.text()
        return {
          connected: false,
          latencyMs: Date.now() - start,
          error: `Asterisk ARI error: ${res.status}`,
          errorType: res.status === 401 ? 'invalid_credentials' : 'unknown',
        } as ConnectionTestResult
      }
      return { connected: true, latencyMs: Date.now() - start }
    } catch (err) {
      return {
        connected: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : 'Network error',
        errorType: 'network_error',
      }
    }
  },

  async listOwnedNumbers(): Promise<OwnedNumber[]> {
    throw new ProviderApiError('Asterisk does not support number listing via API', 400, 'Not supported')
  },

  async searchAvailableNumbers(): Promise<AvailableNumber[]> {
    throw new ProviderApiError('Asterisk does not support number search via API', 400, 'Not supported')
  },

  async provisionNumber(): Promise<OwnedNumber> {
    throw new ProviderApiError('Asterisk does not support number provisioning via API', 400, 'Not supported')
  },

  async configureWebhooks(): Promise<void> {
    throw new ProviderApiError('Asterisk does not support webhook configuration via API', 400, 'Not supported')
  },

  /**
   * Point the PBX's SIP trunk at the operator's carrier.
   *
   * Writes the whole trunk through ARI's dynamic config API — aor, endpoint,
   * identify, and for a registration trunk auth + registration — replacing any
   * trunk already there. sorcery.conf backs these objects with astdb on a
   * volume, so the trunk survives an Asterisk restart. The carrier issues any
   * credentials; they go to the PBX and nowhere else.
   */
  async createSipTrunk(
    credentials: Record<string, unknown>,
    request: SipTrunkRequest,
  ): Promise<SipTrunkConfig> {
    const trunk = parseTrunkRequest(request)
    const ariUrl = String(credentials.ariUrl ?? '')
    const ssrfError = validateExternalUrl(ariUrl, 'Asterisk ARI URL')
    if (ssrfError) {
      throw new ProviderApiError(ssrfError, 400, 'SSRF validation failed')
    }
    const ari = ariConfigClient(ariUrl, String(credentials.ariUsername ?? ''), String(credentials.ariPassword ?? ''))

    // Start from nothing: an update keeps every field it does not name, so a
    // registration trunk re-provisioned as IP-authenticated would keep its
    // outbound auth. Dependents first.
    for (const [type, id] of [...TRUNK_OBJECTS].reverse()) await ari.remove(type, id)

    if (trunk.auth) {
      await ari.put('auth', TRUNK_AUTH, {
        auth_type: 'userpass',
        username: trunk.auth.username,
        password: trunk.auth.password,
      })
    }
    await ari.put('aor', TRUNK, {
      contact: `sip:${trunk.domain}`,
      qualify_frequency: '60',
    })
    await ari.put('endpoint', TRUNK, {
      // astdb stores every field as text and re-parses it on each lookup, and
      // Asterisk writes an unset caller ID as "<unknown>" — which parses back as
      // the NUMBER "unknown", overriding every caller's number. A name-only
      // caller ID round-trips with no number, and then Asterisk takes both name
      // and number from each call's From header, exactly as when it is unset.
      callerid: TRUNK_CALLERID_NAME,
      context: 'from-trunk',
      disallow: 'all',
      allow: 'ulaw,alaw',
      aors: TRUNK,
      direct_media: 'no',
      rtp_symmetric: 'yes',
      force_rport: 'yes',
      rewrite_contact: 'yes',
      dtmf_mode: 'rfc4733',
      ...(trunk.auth && {
        outbound_auth: TRUNK_AUTH,
        from_user: trunk.auth.username,
        from_domain: trunk.host,
      }),
    })
    await ari.put('identify', TRUNK, {
      endpoint: TRUNK,
      match: trunk.inboundMatch.join(','),
    })
    if (trunk.auth) {
      await ari.put('registration', TRUNK, {
        outbound_auth: TRUNK_AUTH,
        server_uri: `sip:${trunk.domain}`,
        client_uri: `sip:${trunk.auth.username}@${trunk.domain}`,
        contact_user: trunk.auth.username,
        retry_interval: '60',
        // Calls the carrier sends to the registered contact carry this line
        // parameter, which identifies them as the trunk's whatever their source.
        line: 'yes',
        endpoint: TRUNK,
      })
    }

    return { sipProvider: trunk.domain, sipUsername: trunk.auth?.username }
  },
}

/**
 * The PBX has exactly one trunk, under fixed ids: the sip-bridge rings
 * volunteers as PJSIP/<number>@trunk and extensions.conf answers the carrier in
 * [from-trunk]. In creation order — each object refers only to earlier ones.
 */
const TRUNK = 'trunk'
const TRUNK_AUTH = 'trunk-auth'
/** Never presented: see the endpoint's `callerid` in createSipTrunk */
const TRUNK_CALLERID_NAME = 'Carrier trunk'
const TRUNK_OBJECTS = [
  ['auth', TRUNK_AUTH],
  ['aor', TRUNK],
  ['endpoint', TRUNK],
  ['identify', TRUNK],
  ['registration', TRUNK],
] as const
type TrunkObjectType = (typeof TRUNK_OBJECTS)[number][0]

// A host[:port] (hostname or IPv4); a match entry may also be an IPv4 CIDR.
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::\d{1,5})?$/
const MATCH_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?:\/\d{1,2})?$/
// The user part of a SIP URI, restricted to what carriers actually issue.
const SIP_USER_RE = /^[A-Za-z0-9._~+-]{1,64}$/

interface TrunkSpec {
  domain: string
  host: string
  inboundMatch: string[]
  auth?: { username: string; password: string }
}

function parseTrunkRequest(request: SipTrunkRequest): TrunkSpec {
  const invalid = (reason: string) => new ProviderApiError(reason, 400, 'Invalid SIP trunk')
  const domain = request.domain.trim()
  if (!HOST_RE.test(domain)) throw invalid('Carrier SIP host must be a hostname or IPv4 address, optionally with :port')
  const host = domain.split(':')[0]

  const { username, password } = request
  if (Boolean(username) !== Boolean(password)) {
    throw invalid('Set both the carrier username and password (registration trunk) or neither (IP-authenticated trunk)')
  }
  if (username && !SIP_USER_RE.test(username)) throw invalid('Carrier username contains characters a SIP URI cannot carry')

  const inboundMatch = request.inboundMatch?.map((m) => m.trim()) ?? [host]
  if (inboundMatch.length === 0 || !inboundMatch.every((m) => MATCH_RE.test(m))) {
    throw invalid('Inbound addresses must be hostnames, IPv4 addresses or IPv4 CIDRs')
  }

  return {
    domain,
    host,
    inboundMatch,
    auth: username && password ? { username, password } : undefined,
  }
}

/** ARI's dynamic config API for the res_pjsip objects of the trunk */
function ariConfigClient(ariUrl: string, ariUsername: string, ariPassword: string) {
  const headers = { Authorization: `Basic ${btoa(`${ariUsername}:${ariPassword}`)}` }
  const url = (type: TrunkObjectType, id: string) =>
    `${ariUrl}/ari/asterisk/config/dynamic/res_pjsip/${type}/${encodeURIComponent(id)}`

  return {
    async put(type: TrunkObjectType, id: string, fields: Record<string, string>): Promise<void> {
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
        throw new ProviderApiError(`Asterisk rejected the SIP trunk's ${type}`, res.status, await res.text())
      }
      await res.body?.cancel()
    },

    /** Delete the object if it exists */
    async remove(type: TrunkObjectType, id: string): Promise<void> {
      const res = await safeFetch(url(type, id), { method: 'DELETE', headers, ssrfGuard: false })
      if (!res.ok && res.status !== 404) {
        throw new ProviderApiError(`Asterisk refused to remove the SIP trunk's ${type}`, res.status, await res.text())
      }
      await res.body?.cancel()
    },
  }
}
