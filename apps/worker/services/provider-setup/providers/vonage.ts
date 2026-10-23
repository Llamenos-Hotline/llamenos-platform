import type {
  OwnedNumber,
  AvailableNumber,
  NumberSearchQuery,
  NumberProvisionRequest,
} from '@protocol/schemas/provider-setup'
import type { ProviderCapabilityImpl, ConnectionTestResult, WebhookUrls } from '../types'
import { ProviderApiError } from '../types'
import { basicAuth, nowISO } from '../utils'
import { safeFetch } from '../../../lib/safe-fetch'

export const vonageProvider: ProviderCapabilityImpl = {
  providerType: 'vonage',
  capabilities: ['listNumbers', 'provisionNumbers', 'autoWebhooks'],

  async testConnection(credentials: Record<string, unknown>): Promise<ConnectionTestResult> {
    const apiKey = String(credentials.apiKey ?? '')
    const apiSecret = String(credentials.apiSecret ?? '')
    const start = Date.now()
    try {
      const res = await safeFetch('https://api.nexmo.com/v2/applications?page_size=1', {
        headers: { Authorization: basicAuth(apiKey, apiSecret) },
      })
      if (!res.ok) {
        await res.text()
        return {
          connected: false,
          latencyMs: Date.now() - start,
          error: `Vonage API error: ${res.status}`,
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

  async listOwnedNumbers(credentials: Record<string, unknown>): Promise<OwnedNumber[]> {
    const apiKey = String(credentials.apiKey ?? '')
    const apiSecret = String(credentials.apiSecret ?? '')
    const res = await safeFetch('https://rest.nexmo.com/account/numbers', {
      headers: { Authorization: basicAuth(apiKey, apiSecret) },
    })
    if (!res.ok) {
      const text = await res.text()
      throw new ProviderApiError('Failed to list Vonage numbers', res.status, text)
    }
    const data = (await res.json()) as {
      numbers: Array<{
        msisdn: string
        country: string
        type: string
        features: string[]
      }>
    }
    return (data.numbers || []).map((n) => ({
      id: n.msisdn,
      phoneNumber: `+${n.msisdn}`,
      providerType: 'vonage',
      friendlyName: `+${n.msisdn} (${n.country})`,
      capabilities: [
        ...(n.features?.includes('VOICE') ?? true ? ['voice'] : []),
        ...(n.features?.includes('SMS') ?? true ? ['sms'] : []),
        ...(n.features?.includes('MMS') ?? false ? ['mms'] : []),
      ],
      createdAt: nowISO(),
      updatedAt: nowISO(),
    }))
  },

  async searchAvailableNumbers(
    credentials: Record<string, unknown>,
    query: NumberSearchQuery,
  ): Promise<AvailableNumber[]> {
    const apiKey = String(credentials.apiKey ?? '')
    const apiSecret = String(credentials.apiSecret ?? '')
    const params = new URLSearchParams({
      country: query.countryCode ?? 'US',
      features: 'VOICE,SMS',
      size: String(Math.min(query.limit ?? 20, 50)),
    })

    const res = await safeFetch(`https://rest.nexmo.com/number/search?${params.toString()}`, {
      headers: { Authorization: basicAuth(apiKey, apiSecret) },
    })
    if (!res.ok) {
      const text = await res.text()
      throw new ProviderApiError('Failed to search Vonage numbers', res.status, text)
    }
    const data = (await res.json()) as {
      numbers: Array<{ msisdn: string; country: string; cost?: string }>
    }
    return (data.numbers || []).map((n) => ({
      phoneNumber: `+${n.msisdn}`,
      providerType: 'vonage',
      capabilities: ['voice', 'sms'],
      locality: n.country,
      monthlyPrice: n.cost,
    }))
  },

  async provisionNumber(
    credentials: Record<string, unknown>,
    request: NumberProvisionRequest,
  ): Promise<OwnedNumber> {
    const apiKey = String(credentials.apiKey ?? '')
    const apiSecret = String(credentials.apiSecret ?? '')
    const countryCode = request.phoneNumber
      ? request.phoneNumber.replace('+', '').slice(0, request.phoneNumber.length > 10 ? request.phoneNumber.replace('+', '').length - 10 : 2) || 'US'
      : 'US'
    const msisdn = request.phoneNumber?.replace('+', '')

    if (!msisdn) {
      throw new ProviderApiError('Vonage provision requires a specific phoneNumber', 400, 'Missing phoneNumber')
    }

    const buyParams = new URLSearchParams({
      country: countryCode,
      msisdn,
    })

    const buyRes = await safeFetch('https://rest.nexmo.com/number/buy', {
      method: 'POST',
      headers: {
        Authorization: basicAuth(apiKey, apiSecret),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: buyParams.toString(),
    })
    if (!buyRes.ok) {
      const text = await buyRes.text()
      throw new ProviderApiError('Failed to provision Vonage number', buyRes.status, text)
    }

    return {
      id: msisdn,
      phoneNumber: `+${msisdn}`,
      providerType: 'vonage',
      capabilities: ['voice', 'sms'],
      createdAt: nowISO(),
      updatedAt: nowISO(),
    }
  },

  async configureWebhooks(
    credentials: Record<string, unknown>,
    number: string,
    urls: WebhookUrls,
  ): Promise<void> {
    const apiKey = String(credentials.apiKey ?? '')
    const apiSecret = String(credentials.apiSecret ?? '')
    const authHeader = basicAuth(apiKey, apiSecret)

    const appBody: Record<string, unknown> = {
      name: `Llamenos - ${urls.voiceIncoming}`,
      capabilities: {
        voice: {
          webhooks: {
            answer_url: { address: urls.voiceIncoming, http_method: 'POST' },
            event_url: { address: urls.voiceStatus, http_method: 'POST' },
          },
        },
      },
    }
    if (urls.sms) {
      ;(appBody.capabilities as Record<string, unknown>).messages = {
        webhooks: {
          inbound_url: { address: urls.sms, http_method: 'POST' },
          // Delivery-status updates arrive on the same route as inbound messages
          // (messaging/router.ts tries parseStatusWebhook first). There is no
          // `/status` sibling — the old replace() registered a 404 (#2068).
          status_url: { address: urls.sms, http_method: 'POST' },
        },
      }
    }

    const appRes = await safeFetch('https://api.nexmo.com/v2/applications', {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(appBody),
    })
    if (!appRes.ok) {
      const text = await appRes.text()
      throw new ProviderApiError('Failed to create Vonage application', appRes.status, text)
    }
    const appData = (await appRes.json()) as { id: string }

    const msisdn = number.replace('+', '')
    const linkParams = new URLSearchParams({
      country: msisdn.length > 10 ? msisdn.slice(0, msisdn.length - 10) : 'US',
      msisdn,
      app_id: appData.id,
    })

    const linkRes = await safeFetch('https://rest.nexmo.com/number/update', {
      method: 'POST',
      headers: {
        Authorization: basicAuth(apiKey, apiSecret),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: linkParams.toString(),
    })
    if (!linkRes.ok) {
      const text = await linkRes.text()
      throw new ProviderApiError('Failed to link Vonage number to application', linkRes.status, text)
    }
  },

  async createSipTrunk(): Promise<never> {
    throw new ProviderApiError('Vonage does not support SIP trunk creation', 400, 'Not supported')
  },
}
