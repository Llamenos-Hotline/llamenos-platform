import type {
  OwnedNumber,
  AvailableNumber,
} from '@protocol/schemas/provider-setup'
import type { ProviderCapabilityImpl, ConnectionTestResult, SipTrunkConfig, SipTrunkRequest } from '../types'
import { ProviderApiError } from '../types'
import { isInternalAddress } from '../../../lib/ssrf-guard'
import { safeFetch } from '../../../lib/safe-fetch'

/**
 * Determine ESL base URL. Defaults to HTTPS unless eslUseTls is explicitly false
 * AND the host is a loopback/private address.
 */
function getEslBaseUrl(credentials: Record<string, unknown>): string {
  const eslHost = String(credentials.eslHost ?? '')
  const eslPort = Number(credentials.eslPort ?? 8021)
  const eslUseTls = credentials.eslUseTls !== false

  if (eslUseTls) {
    return `https://${eslHost}:${eslPort}`
  }

  // Only allow plaintext HTTP for loopback/private IPs
  if (!isInternalAddress(eslHost)) {
    throw new ProviderApiError(
      'ESL over plaintext HTTP is only allowed for loopback/private addresses. Set eslUseTls: true for external hosts.',
      400,
      'TLS required for external hosts',
    )
  }

  return `http://${eslHost}:${eslPort}`
}

export const freeswitchProvider: ProviderCapabilityImpl = {
  providerType: 'freeswitch',
  capabilities: ['sipTrunks'],

  async testConnection(credentials: Record<string, unknown>): Promise<ConnectionTestResult> {
    const eslPassword = String(credentials.eslPassword ?? '')
    const baseUrl = getEslBaseUrl(credentials)
    const start = Date.now()
    try {
      const res = await safeFetch(`${baseUrl}/api/sofia?status`, {
        headers: {
          Authorization: `Basic ${btoa(`:${eslPassword}`)}`,
        },
        ssrfGuard: false,
      })
      if (!res.ok) {
        await res.text()
        return {
          connected: false,
          latencyMs: Date.now() - start,
          error: `FreeSWITCH ESL error: ${res.status}`,
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
    throw new ProviderApiError('FreeSWITCH does not support number listing via API', 400, 'Not supported')
  },

  async searchAvailableNumbers(): Promise<AvailableNumber[]> {
    throw new ProviderApiError('FreeSWITCH does not support number search via API', 400, 'Not supported')
  },

  async provisionNumber(): Promise<OwnedNumber> {
    throw new ProviderApiError('FreeSWITCH does not support number provisioning via API', 400, 'Not supported')
  },

  async configureWebhooks(): Promise<void> {
    throw new ProviderApiError('FreeSWITCH does not support webhook configuration via API', 400, 'Not supported')
  },

  async createSipTrunk(
    credentials: Record<string, unknown>,
    { domain }: SipTrunkRequest,
  ): Promise<SipTrunkConfig> {
    const eslPassword = String(credentials.eslPassword ?? '')
    const baseUrl = getEslBaseUrl(credentials)

    const sipUsername = `llamenos-${crypto.randomUUID().slice(0, 8)}`
    const sipPassword = Array.from(crypto.getRandomValues(new Uint8Array(24)))
      .map((b) => b.toString(36).padStart(2, '0'))
      .join('')
      .slice(0, 32)

    const res = await safeFetch(`${baseUrl}/api/bgapi`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`:${eslPassword}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `command=sofia profile external gwadd ${sipUsername} ${domain} ${sipUsername} ${sipPassword}`,
      ssrfGuard: false,
    })
    if (!res.ok) {
      const text = await res.text()
      throw new ProviderApiError('Failed to create FreeSWITCH SIP trunk', res.status, text)
    }

    return {
      sipProvider: domain,
      sipUsername,
      sipPassword,
    }
  },
}
