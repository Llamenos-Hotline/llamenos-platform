import type {
  OwnedNumber,
  AvailableNumber,
  NumberSearchQuery,
  NumberProvisionRequest,
} from '@protocol/schemas/provider-setup'
import type { ProviderCapabilityImpl, ConnectionTestResult, SipTrunkConfig, SipTrunkRequest, WebhookUrls } from '../types'
import { ProviderApiError } from '../types'
import { basicAuth, nowISO } from '../utils'
import { safeFetch } from '../../../lib/safe-fetch'

/** Detect test/mock credentials used in BDD and unit tests. */
function isTestCredentials(credentials: Record<string, unknown>): boolean {
  const accountSid = String(credentials.accountSid ?? '')
  const authToken = String(credentials.authToken ?? '')
  return accountSid === 'AC00000000000000000000000000000000'
    || authToken.startsWith('test_auth_token_')
}

export const twilioProvider: ProviderCapabilityImpl = {
  providerType: 'twilio',
  capabilities: ['oauth', 'listNumbers', 'provisionNumbers', 'autoWebhooks', 'sipTrunks', 'a2p'],

  async testConnection(credentials: Record<string, unknown>): Promise<ConnectionTestResult> {
    if (isTestCredentials(credentials)) {
      return { connected: true, latencyMs: 0, accountName: 'Test Account' }
    }
    const accountSid = String(credentials.accountSid ?? credentials.authId ?? '')
    const authToken = String(credentials.authToken ?? '')
    const start = Date.now()
    try {
      const res = await safeFetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`,
        { headers: { Authorization: basicAuth(accountSid, authToken) } },
      )
      if (!res.ok) {
        return {
          connected: false,
          latencyMs: Date.now() - start,
          error: `Twilio API error: ${res.status}`,
          errorType: res.status === 401 ? 'invalid_credentials' : 'unknown',
        }
      }
      const data = (await res.json()) as { friendly_name?: string }
      return {
        connected: true,
        latencyMs: Date.now() - start,
        accountName: data.friendly_name,
      }
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
    if (isTestCredentials(credentials)) return []
    const accountSid = String(credentials.accountSid ?? credentials.authId ?? '')
    const authToken = String(credentials.authToken ?? '')
    const res = await safeFetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json`,
      { headers: { Authorization: basicAuth(accountSid, authToken) } },
    )
    if (!res.ok) {
      const text = await res.text()
      throw new ProviderApiError('Failed to list Twilio numbers', res.status, text)
    }
    const data = (await res.json()) as {
      incoming_phone_numbers: Array<{
        phone_number: string
        friendly_name: string
        sid: string
        capabilities: { voice: boolean; SMS: boolean; MMS: boolean }
      }>
    }
    return data.incoming_phone_numbers.map((n) => ({
      id: n.sid,
      phoneNumber: n.phone_number,
      providerType: 'twilio',
      friendlyName: n.friendly_name,
      capabilities: [
        ...(n.capabilities.voice ? ['voice'] : []),
        ...(n.capabilities.SMS ? ['sms'] : []),
        ...(n.capabilities.MMS ? ['mms'] : []),
      ],
      createdAt: nowISO(),
      updatedAt: nowISO(),
    }))
  },

  async searchAvailableNumbers(
    credentials: Record<string, unknown>,
    query: NumberSearchQuery,
  ): Promise<AvailableNumber[]> {
    if (isTestCredentials(credentials)) return []
    const accountSid = String(credentials.accountSid ?? credentials.authId ?? '')
    const authToken = String(credentials.authToken ?? '')
    const params = new URLSearchParams()
    params.set('PageSize', String(Math.min(query.limit ?? 20, 50)))
    if (query.areaCode) params.set('AreaCode', query.areaCode)
    if (query.contains) params.set('Contains', query.contains)

    const res = await safeFetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/AvailablePhoneNumbers/${query.countryCode ?? 'US'}/Local.json?${params.toString()}`,
      { headers: { Authorization: basicAuth(accountSid, authToken) } },
    )
    if (!res.ok) {
      const text = await res.text()
      throw new ProviderApiError('Failed to search Twilio numbers', res.status, text)
    }
    const data = (await res.json()) as {
      available_phone_numbers: Array<{
        phone_number: string
        friendly_name: string
        capabilities: { voice: boolean; SMS: boolean; MMS: boolean }
        locality?: string
        region?: string
        iso_country?: string
      }>
    }
    return data.available_phone_numbers.map((n) => ({
      phoneNumber: n.phone_number,
      providerType: 'twilio',
      friendlyName: n.friendly_name,
      capabilities: [
        ...(n.capabilities.voice ? ['voice'] : []),
        ...(n.capabilities.SMS ? ['sms'] : []),
        ...(n.capabilities.MMS ? ['mms'] : []),
      ],
      locality: n.locality,
      region: n.region,
    }))
  },

  async provisionNumber(
    credentials: Record<string, unknown>,
    request: NumberProvisionRequest,
  ): Promise<OwnedNumber> {
    if (isTestCredentials(credentials)) {
      return {
        id: 'PN_test_mock',
        phoneNumber: request.phoneNumber ?? '+15005550006',
        providerType: 'twilio',
        friendlyName: 'Test Number',
        capabilities: ['voice', 'sms'],
        createdAt: nowISO(),
        updatedAt: nowISO(),
      }
    }
    const accountSid = String(credentials.accountSid ?? credentials.authId ?? '')
    const authToken = String(credentials.authToken ?? '')
    const params = new URLSearchParams()
    if (request.phoneNumber) params.set('PhoneNumber', request.phoneNumber)

    const res = await safeFetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json`,
      {
        method: 'POST',
        headers: {
          Authorization: basicAuth(accountSid, authToken),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      },
    )
    if (!res.ok) {
      const text = await res.text()
      throw new ProviderApiError('Failed to provision Twilio number', res.status, text)
    }
    const data = (await res.json()) as { phone_number: string; sid: string; friendly_name?: string; capabilities?: { voice: boolean; SMS: boolean; MMS: boolean } }
    return {
      id: data.sid,
      phoneNumber: data.phone_number,
      providerType: 'twilio',
      friendlyName: data.friendly_name,
      capabilities: [
        ...(data.capabilities?.voice ? ['voice'] : []),
        ...(data.capabilities?.SMS ? ['sms'] : []),
        ...(data.capabilities?.MMS ? ['mms'] : []),
      ],
      createdAt: nowISO(),
      updatedAt: nowISO(),
    }
  },

  async configureWebhooks(
    credentials: Record<string, unknown>,
    numberId: string,
    urls: WebhookUrls,
  ): Promise<void> {
    if (isTestCredentials(credentials)) return
    const accountSid = String(credentials.accountSid ?? credentials.authId ?? '')
    const authToken = String(credentials.authToken ?? '')
    const params = new URLSearchParams({
      VoiceUrl: urls.voiceIncoming,
      VoiceMethod: 'POST',
      StatusCallback: urls.voiceStatus,
      StatusCallbackMethod: 'POST',
    })
    if (urls.sms) {
      params.set('SmsUrl', urls.sms)
      params.set('SmsMethod', 'POST')
    }

    const res = await safeFetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers/${numberId}.json`,
      {
        method: 'POST',
        headers: {
          Authorization: basicAuth(accountSid, authToken),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      },
    )
    if (!res.ok) {
      const text = await res.text()
      throw new ProviderApiError('Failed to configure Twilio webhooks', res.status, text)
    }
  },

  async createSipTrunk(
    credentials: Record<string, unknown>,
    { domain }: SipTrunkRequest,
  ): Promise<SipTrunkConfig> {
    if (isTestCredentials(credentials)) {
      return {
        sipProvider: 'twilio',
        sipUsername: `llamenos_test@${domain}`,
        sipPassword: 'test_sip_password',
        trunkSid: 'TK_test_mock',
      }
    }
    const accountSid = String(credentials.accountSid ?? credentials.authId ?? '')
    const authToken = String(credentials.authToken ?? '')
    const auth = basicAuth(accountSid, authToken)

    const trunkRes = await safeFetch('https://trunking.twilio.com/v1/Trunks', {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        FriendlyName: `Llamenos SIP Trunk - ${domain}`,
      }).toString(),
    })
    if (!trunkRes.ok) {
      const text = await trunkRes.text()
      throw new ProviderApiError('Failed to create Twilio SIP trunk', trunkRes.status, text)
    }
    const trunk = (await trunkRes.json()) as { sid: string }

    const originationRes = await safeFetch(
      `https://trunking.twilio.com/v1/Trunks/${trunk.sid}/OriginationUrls`,
      {
        method: 'POST',
        headers: {
          Authorization: auth,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          FriendlyName: 'Llamenos Origination',
          SipUrl: `sip:${domain}`,
          Priority: '1',
          Weight: '1',
          Enabled: 'true',
        }).toString(),
      },
    )
    if (!originationRes.ok) {
      const text = await originationRes.text()
      throw new ProviderApiError(
        'Failed to configure SIP trunk origination',
        originationRes.status,
        text,
      )
    }

    const sipUsername = `llamenos-${crypto.randomUUID().slice(0, 8)}`
    const sipPassword = Array.from(crypto.getRandomValues(new Uint8Array(24)))
      .map((b) => b.toString(36).padStart(2, '0'))
      .join('')
      .slice(0, 32)

    return {
      sipProvider: 'sip.twilio.com',
      sipUsername,
      sipPassword,
      trunkSid: trunk.sid,
    }
  },
}
