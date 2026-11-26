import { request } from '../api'
import { hp } from './client'
import type {
  StartOAuthRequest,
  StartOAuthResponse,
  OauthFlowState,
  ConfigureProviderRequest,
  ProviderStatusResponse,
  NumberSearchQuery,
  NumberProvisionRequest,
  OwnedNumber,
  WebhookUrlsResponse,
} from '@protocol/schemas/provider-setup'
import type { TelephonyProviderType } from '@shared/types'
import type { A2pRegistrationState, AvailableNumberList, OkResponse, OwnedNumberList, SignalRegisterRequest, SignalRegistration, SignalVerifyRequest } from '@protocol/schemas'

// ── OAuth ──────────────────────────────────────────────────────────────────

export async function startOAuth(
  provider: TelephonyProviderType,
  redirectUrl: string,
  hubId?: string,
): Promise<StartOAuthResponse> {
  return request<StartOAuthResponse>('/provider-setup/oauth/start', {
    method: 'POST',
    body: JSON.stringify({ provider, redirectUrl, hubId } satisfies StartOAuthRequest),
  })
}

export async function getOAuthStatus(state: string): Promise<OauthFlowState> {
  return request<OauthFlowState>(`/provider-setup/oauth/status/${encodeURIComponent(state)}`)
}

// ── Webhook URLs ───────────────────────────────────────────────────────────

/**
 * The webhook URLs a provider must be configured to call, built by the server
 * on its public webhook origin — the same ones its own auto-configuration
 * registers (#2068). Never assemble them here: `window.location.origin` is the
 * desktop webview's origin, not the server's.
 */
export async function getWebhookUrls(): Promise<WebhookUrlsResponse> {
  return request<WebhookUrlsResponse>(hp('/provider-setup/webhook-urls'))
}

// ── Provider Configuration ─────────────────────────────────────────────────

export async function configureProvider(
  provider: TelephonyProviderType,
  credentials: Record<string, string>,
  hubId?: string,
) {
  return request<OkResponse>('/provider-setup/configure', {
    method: 'POST',
    body: JSON.stringify({ provider, credentials, hubId } satisfies ConfigureProviderRequest),
  })
}

export async function testProviderConnection(
  provider: string,
  hubId?: string,
): Promise<{
  connected: boolean
  latencyMs: number
  accountName?: string
  error?: string
  errorType?: string
}> {
  return request('/provider-setup/test', {
    method: 'POST',
    body: JSON.stringify({ provider, hubId }),
  })
}

export async function getProviderStatus(
  provider: string,
  hubId?: string,
): Promise<ProviderStatusResponse> {
  const qs = new URLSearchParams()
  if (hubId) qs.set('hubId', hubId)
  return request<ProviderStatusResponse>(`/provider-setup/status/${encodeURIComponent(provider)}?${qs}`)
}

// ── Phone Numbers ──────────────────────────────────────────────────────────

export async function listPhoneNumbers(
  provider: string,
  hubId?: string,
): Promise<{ numbers: OwnedNumber[] }> {
  const qs = new URLSearchParams()
  qs.set('provider', provider)
  if (hubId) qs.set('hubId', hubId)
  return request<OwnedNumberList>(`/provider-setup/phone-numbers?${qs}`)
}

export async function searchPhoneNumbers(query: NumberSearchQuery) {
  return request<AvailableNumberList>('/provider-setup/phone-numbers/search', {
    method: 'POST',
    body: JSON.stringify(query),
  })
}

export async function provisionPhoneNumber(body: NumberProvisionRequest): Promise<OwnedNumber> {
  return request<OwnedNumber>('/provider-setup/phone-numbers/provision', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// ── Webhooks ───────────────────────────────────────────────────────────────

export async function configureWebhooks(
  provider: string,
  numberId: string,
  opts?: { enableSms?: boolean; hubId?: string },
) {
  return request<OkResponse>('/provider-setup/configure-webhooks', {
    method: 'POST',
    body: JSON.stringify({
      provider,
      numberId,
      enableSms: opts?.enableSms ?? false,
      hubId: opts?.hubId,
    }),
  })
}

export async function createSipTrunk(
  provider: string,
  domain: string,
  hubId?: string,
): Promise<{
  sipProvider: string
  sipUsername: string
  credentialsStored: boolean
  sipPassword: string
  trunkSid?: string
  connectionId?: string
}> {
  return request('/provider-setup/create-sip-trunk', {
    method: 'POST',
    body: JSON.stringify({ provider, domain, hubId }),
  })
}

// ── Signal Registration ────────────────────────────────────────────────────

export interface SignalRegisterBody {
  bridgeUrl: string
  phoneNumber: string
  method?: 'sms' | 'voice'
  hubId?: string
}

export interface SignalVerifyBody {
  registrationId: string
  code: string
  hubId?: string
}

export interface SignalRegistrationResult {
  id: string
  hubId: string
  bridgeUrl?: string
  phoneNumber: string
  method: string
  status: string
  error?: string
  expiresAt?: string
  createdAt: string
  updatedAt: string
}

export async function startSignalRegistration(
  body: SignalRegisterRequest,
) {
  return request<SignalRegistration>('/provider-setup/signal/register', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function getSignalStatus(
  opts?: { registrationId?: string; hubId?: string },
): Promise<SignalRegistrationResult> {
  const qs = new URLSearchParams()
  if (opts?.registrationId) qs.set('registrationId', opts.registrationId)
  if (opts?.hubId) qs.set('hubId', opts.hubId)
  return request<SignalRegistration>(`/provider-setup/signal/status?${qs}`)
}

export async function verifySignalCode(body: SignalVerifyRequest) {
  return request<SignalRegistration>('/provider-setup/signal/verify', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function unregisterSignal(
  registrationId: string,
  hubId?: string,
) {
  const qs = new URLSearchParams()
  qs.set('registrationId', registrationId)
  if (hubId) qs.set('hubId', hubId)
  return request<OkResponse>(`/provider-setup/signal/unregister?${qs}`, { method: 'DELETE' })
}

export async function getSignalAccount(
  registrationId: string,
): Promise<{ registered: boolean; uuid?: string; number?: string }> {
  return request(`/provider-setup/signal/account?registrationId=${encodeURIComponent(registrationId)}`)
}

// ── A2P Registration ───────────────────────────────────────────────────────

export interface A2PBrandInfo {
  entityType: string
  companyName: string
  ein: string
  phone: string
  street: string
  city: string
  state: string
  postalCode: string
  country: string
  email: string
  website?: string
  vertical?: string
}

export interface A2PCampaignInfo {
  useCase: string
  description: string
  helpMessage: string
  optinMessage: string
  optoutMessage: string
  sampleMessages: string[]
  embeddedLink?: boolean
  embeddedPhone?: boolean
  subscriberOptin?: boolean
  subscriberOptout?: boolean
  subscriberHelp?: boolean
}

export async function submitA2PBrand(
  brandInfo: A2PBrandInfo,
  providerType?: string,
  hubId?: string,
): Promise<A2pRegistrationState> {
  return request('/provider-setup/a2p/brand', {
    method: 'POST',
    body: JSON.stringify({ brandInfo, providerType: providerType ?? 'twilio', hubId }),
  })
}

export async function submitA2PCampaign(
  registrationId: string,
  campaignInfo: A2PCampaignInfo,
  hubId?: string,
): Promise<A2pRegistrationState> {
  return request('/provider-setup/a2p/campaign', {
    method: 'POST',
    body: JSON.stringify({ registrationId, campaignInfo, hubId }),
  })
}

export async function getA2PStatus(
  opts?: { registrationId?: string; hubId?: string },
): Promise<A2pRegistrationState> {
  const qs = new URLSearchParams()
  if (opts?.registrationId) qs.set('registrationId', opts.registrationId)
  if (opts?.hubId) qs.set('hubId', opts.hubId)
  return request(`/provider-setup/a2p/status?${qs}`)
}

export async function skipA2P(providerType?: string, hubId?: string): Promise<A2pRegistrationState> {
  return request('/provider-setup/a2p/skip', {
    method: 'POST',
    body: JSON.stringify({ providerType: providerType ?? 'twilio', hubId }),
  })
}
