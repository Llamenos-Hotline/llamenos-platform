import type {
  OwnedNumber,
  AvailableNumber,
  NumberSearchQuery,
  NumberProvisionRequest,
} from '@protocol/schemas/provider-setup'
import type { ProviderCapabilityImpl, ConnectionTestResult, SipTrunkConfig, SipTrunkRequest, WebhookUrls } from '../types'
import { ProviderApiError } from '../types'
import { nowISO } from '../utils'
import { safeFetch } from '../../../lib/safe-fetch'

export const telnyxProvider: ProviderCapabilityImpl = {
  providerType: 'telnyx',
  capabilities: ['oauth', 'listNumbers', 'provisionNumbers', 'autoWebhooks', 'sipTrunks'],

  async testConnection(credentials: Record<string, unknown>): Promise<ConnectionTestResult> {
    const apiKey = String(credentials.apiKey ?? credentials.accessToken ?? '')
    const start = Date.now()
    try {
      const res = await safeFetch('https://api.telnyx.com/v2/phone_numbers?page[size]=1', {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      if (!res.ok) {
        await res.text()
        return {
          connected: false,
          latencyMs: Date.now() - start,
          error: `Telnyx API error: ${res.status}`,
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
    const apiKey = String(credentials.apiKey ?? credentials.accessToken ?? '')
    const res = await safeFetch('https://api.telnyx.com/v2/phone_numbers?page[size]=250', {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!res.ok) {
      const text = await res.text()
      throw new ProviderApiError('Failed to list Telnyx numbers', res.status, text)
    }
    const data = (await res.json()) as {
      data: Array<{
        id: string
        phone_number: string
        connection_name: string
        status: string
      }>
    }
    return data.data.map((n) => ({
      id: n.id,
      phoneNumber: n.phone_number,
      providerType: 'telnyx',
      friendlyName: n.connection_name || n.phone_number,
      capabilities: ['voice', 'sms', 'mms'],
      createdAt: nowISO(),
      updatedAt: nowISO(),
    }))
  },

  async searchAvailableNumbers(
    credentials: Record<string, unknown>,
    query: NumberSearchQuery,
  ): Promise<AvailableNumber[]> {
    const apiKey = String(credentials.apiKey ?? credentials.accessToken ?? '')
    const params = new URLSearchParams({ 'filter[limit]': String(Math.min(query.limit ?? 20, 50)) })
    if (query.areaCode) params.set('filter[national_destination_code]', query.areaCode)

    const res = await safeFetch(
      `https://api.telnyx.com/v2/available_phone_numbers?${params.toString()}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    )
    if (!res.ok) {
      const text = await res.text()
      throw new ProviderApiError('Failed to search Telnyx numbers', res.status, text)
    }
    const data = (await res.json()) as {
      data: Array<{
        phone_number: string
        locality?: string
        region?: string
        monthly_price?: string
      }>
    }
    return data.data.map((n) => ({
      phoneNumber: n.phone_number,
      providerType: 'telnyx',
      capabilities: ['voice', 'sms', 'mms'],
      locality: n.locality,
      region: n.region,
      monthlyPrice: n.monthly_price,
    }))
  },

  async provisionNumber(
    credentials: Record<string, unknown>,
    request: NumberProvisionRequest,
  ): Promise<OwnedNumber> {
    const apiKey = String(credentials.apiKey ?? credentials.accessToken ?? '')
    const searchParams = new URLSearchParams({ 'filter[limit]': '1' })
    if (request.phoneNumber) {
      searchParams.set('filter[phone_number][starts_with]', request.phoneNumber)
    }

    const searchRes = await safeFetch(
      `https://api.telnyx.com/v2/available_phone_numbers?${searchParams.toString()}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    )
    if (!searchRes.ok) {
      const text = await searchRes.text()
      throw new ProviderApiError('Failed to search Telnyx numbers', searchRes.status, text)
    }
    const searchData = (await searchRes.json()) as {
      data: Array<{ phone_number: string }>
    }
    if (searchData.data.length === 0) {
      throw new ProviderApiError('No available numbers found', 404, 'No numbers available')
    }
    const phoneNumber = searchData.data[0].phone_number

    const orderRes = await safeFetch('https://api.telnyx.com/v2/number_orders', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ phone_numbers: [{ phone_number: phoneNumber }] }),
    })
    if (!orderRes.ok) {
      const text = await orderRes.text()
      throw new ProviderApiError('Failed to provision Telnyx number', orderRes.status, text)
    }
    const orderData = (await orderRes.json()) as {
      data: { id: string; phone_numbers: Array<{ phone_number: string }> }
    }
    return {
      id: orderData.data.id,
      phoneNumber: orderData.data.phone_numbers[0]?.phone_number || phoneNumber,
      providerType: 'telnyx',
      capabilities: ['voice', 'sms', 'mms'],
      createdAt: nowISO(),
      updatedAt: nowISO(),
    }
  },

  async configureWebhooks(
    credentials: Record<string, unknown>,
    numberId: string,
    urls: WebhookUrls,
  ): Promise<void> {
    const apiKey = String(credentials.apiKey ?? credentials.accessToken ?? '')
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }

    const appBody: Record<string, unknown> = {
      application_name: `Llamenos - ${urls.voiceIncoming}`,
      webhook_event_url: urls.voiceIncoming,
      webhook_event_failover_url: urls.voiceStatus,
      active: true,
    }
    if (urls.sms) {
      appBody.inbound_message_webhook_url = urls.sms
    }

    const appRes = await safeFetch('https://api.telnyx.com/v2/call_control_applications', {
      method: 'POST',
      headers,
      body: JSON.stringify(appBody),
    })
    if (!appRes.ok) {
      const text = await appRes.text()
      throw new ProviderApiError('Failed to create Telnyx application', appRes.status, text)
    }
    const appData = (await appRes.json()) as { data: { id: string } }

    const patchRes = await safeFetch(`https://api.telnyx.com/v2/phone_numbers/${numberId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ connection_id: appData.data.id }),
    })
    if (!patchRes.ok) {
      const text = await patchRes.text()
      throw new ProviderApiError(
        'Failed to associate Telnyx number with application',
        patchRes.status,
        text,
      )
    }
  },

  async createSipTrunk(
    credentials: Record<string, unknown>,
    { domain }: SipTrunkRequest,
  ): Promise<SipTrunkConfig> {
    const apiKey = String(credentials.apiKey ?? credentials.accessToken ?? '')
    const sipUsername = `llamenos-${crypto.randomUUID().slice(0, 8)}`
    const sipPassword = Array.from(crypto.getRandomValues(new Uint8Array(24)))
      .map((b) => b.toString(36).padStart(2, '0'))
      .join('')
      .slice(0, 32)

    const res = await safeFetch('https://api.telnyx.com/v2/ip_connections', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        connection_name: `Llamenos SIP - ${domain}`,
        active: true,
        transport_protocol: 'UDP',
        default_on_hold_comfort_noise_enabled: true,
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new ProviderApiError('Failed to create Telnyx SIP connection', res.status, text)
    }
    const data = (await res.json()) as { data: { id: string } }

    return {
      sipProvider: 'sip.telnyx.com',
      sipUsername,
      sipPassword,
      connectionId: data.data.id,
    }
  },
}
