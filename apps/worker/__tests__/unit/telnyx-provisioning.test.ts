/**
 * #2305 — a number provisioned for Telnyx is routed to a TeXML application,
 * whose voice URL is the incoming webhook. A Call Control application posts
 * every call event to that one URL, which is why a caller could never get past
 * the language menu.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { telephonyProviderSchema } from '@protocol/schemas/settings'
import { telnyxProvider } from '@worker/services/provider-setup/providers/telnyx'

afterEach(() => vi.restoreAllMocks())

describe('telnyxProvider.configureWebhooks', () => {
  const urls = {
    voiceIncoming: 'https://hotline.example.org/api/telephony/incoming',
    voiceStatus: 'https://hotline.example.org/api/telephony/call-status',
  }

  it('creates a TeXML application that fetches its instructions by POST, and points the number at it', async () => {
    const calls: Array<{ url: string; method?: string; body: Record<string, unknown> }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body)) })
      return Response.json({ data: { id: 'texml-app-1' } })
    })

    await telnyxProvider.configureWebhooks!({ apiKey: 'k' }, 'number-1', urls)

    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual([
      'POST https://api.telnyx.com/v2/texml_applications',
      'PATCH https://api.telnyx.com/v2/phone_numbers/number-1',
    ])
    expect(calls[0]!.body).toMatchObject({ voice_url: urls.voiceIncoming, voice_method: 'post', active: true })
    expect(calls[0]!.body).not.toHaveProperty('webhook_event_url')
    expect(calls[1]!.body).toEqual({ connection_id: 'texml-app-1' })
  })

  it('reports a refused application as a provider error, and never touches the number', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('nope', { status: 422 }))
    await expect(telnyxProvider.configureWebhooks!({ apiKey: 'k' }, 'number-1', urls)).rejects.toThrow(/TeXML application/)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('telephonyProviderSchema', () => {
  it('keeps the Telnyx TeXML application id, which PROVIDER_REQUIRED_FIELDS requires — a z.object() drops undeclared keys', () => {
    const parsed = telephonyProviderSchema.parse({ type: 'telnyx', apiKey: 'k', connectionId: 'texml-app-1', phoneNumber: '+15551234567' })
    expect(parsed.connectionId).toBe('texml-app-1')
  })
})
