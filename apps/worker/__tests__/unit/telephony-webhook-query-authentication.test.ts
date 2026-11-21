/**
 * #2627 — which providers' webhook authentication covers the QUERY STRING.
 *
 * The call-status route used to take its call (and so its hub) from a
 * `parentCallSid` in the query whenever there was no usable call token. That is
 * only as safe as the signature over the URL, and the providers differ. This is
 * the per-adapter evidence: each provider's genuine signature is made over a
 * callback, then ONE query parameter is changed and the callback is re-verified.
 *
 *   covers the query  → the altered request is refused
 *   does not cover it → the altered request still verifies, so nothing in the
 *                       query is evidence of anything, and a route must not
 *                       derive a hub (or a call) from it
 *
 * Telnyx signs the body only and covers the query with its own HMAC tag; that
 * case is pinned in telnyx-texml-flow.test.ts (`mutate(...)`), not repeated here.
 */
import { describe, it, expect } from 'vitest'
import { TwilioAdapter } from '@worker/telephony/twilio'
import { SignalWireAdapter } from '@worker/telephony/signalwire'
import { VonageAdapter } from '@worker/telephony/vonage'
import { PlivoAdapter } from '@worker/telephony/plivo'
import { BandwidthAdapter } from '@worker/telephony/bandwidth'
import { AsteriskAdapter } from '@worker/telephony/asterisk'
import { FreeSwitchAdapter } from '@worker/telephony/freeswitch'
import type { TelephonyAdapter } from '@worker/telephony/adapter'

const ORIGIN = 'https://hotline.example.org'
const PATH = '/api/telephony/call-status'
const GENUINE = `${ORIGIN}${PATH}?callToken=tok-genuine`

const enc = new TextEncoder()
const FORM = 'CallStatus=completed&CallSid=CA1'

async function hmac(hash: 'SHA-1' | 'SHA-256', secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)))
}
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))
const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('')

/** The one thing a provider genuinely sent: a signed request for `url`. */
interface Scheme {
  name: string
  adapter: TelephonyAdapter
  covers: boolean
  /** Sign a callback for `url`; the result is replayed against a different URL. */
  sign(url: string): Promise<{ headers: Record<string, string>; body: string; url: string }>
}

const schemes: Scheme[] = [
  {
    name: 'twilio',
    covers: true,
    adapter: new TwilioAdapter('AC1', 'twilio-token', '+15551234567'),
    sign: async (url) => ({
      url,
      body: FORM,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': b64(await hmac('SHA-1', 'twilio-token', `${url}CallSid` + 'CA1' + 'CallStatus' + 'completed')),
      },
    }),
  },
  {
    name: 'signalwire',
    covers: true,
    adapter: new SignalWireAdapter('11111111-2222-3333-4444-555555555555', 'sw-token', '+15551234567', 'space'),
    sign: async (url) => ({
      url,
      body: FORM,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-SignalWire-Signature': b64(await hmac('SHA-1', 'sw-token', `${url}CallSid` + 'CA1' + 'CallStatus' + 'completed')),
      },
    }),
  },
  {
    name: 'vonage',
    covers: true,
    adapter: new VonageAdapter('key', 'vonage-secret', 'app', '+15551234567'),
    sign: async (url) => {
      const u = new URL(url)
      u.searchParams.set('timestamp', String(Math.floor(Date.now() / 1000)))
      const input = Array.from(u.searchParams.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `&${k}=${v}`)
        .join('')
      u.searchParams.set('sig', hex(await hmac('SHA-256', 'vonage-secret', input)))
      return { url: u.toString(), body: '{}', headers: { 'Content-Type': 'application/json' } }
    },
  },
  {
    name: 'plivo',
    covers: false,
    adapter: new PlivoAdapter('id', 'plivo-token', '+15551234567'),
    sign: async (url) => {
      const u = new URL(url)
      const nonce = 'nonce-1'
      // V3: the URL WITHOUT its query, the sorted POST params, then the nonce.
      const input = `${u.origin}${u.pathname}CallSid` + 'CA1' + 'CallStatus' + 'completed' + `.${nonce}`
      return {
        url,
        body: FORM,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Plivo-Signature-V3': b64(await hmac('SHA-256', 'plivo-token', input)),
          'X-Plivo-Signature-V3-Nonce': nonce,
        },
      }
    },
  },
  {
    name: 'bandwidth',
    covers: false,
    adapter: new BandwidthAdapter('acct', 'bw-token', 'bw-secret', 'app', '+15551234567'),
    sign: async (url) => ({
      url,
      body: JSON.stringify({ eventType: 'disconnect', callId: 'c-1' }),
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${btoa('bw-token:bw-secret')}` },
    }),
  },
  ...([
    ['asterisk', new AsteriskAdapter('http://ari.local:8088', 'admin', 'password', '+15551234567', 'http://callback.local/webhooks', 'bridge-secret')],
    ['freeswitch', new FreeSwitchAdapter('+15551234567', 'http://bridge.local/webhooks', 'bridge-secret', 'http://callback.local')],
  ] as const).map(([name, adapter]): Scheme => ({
    name,
    covers: true,
    adapter,
    sign: async (url) => {
      const body = JSON.stringify({ event: 'status' })
      const ts = String(Date.now())
      return {
        url,
        body,
        headers: {
          'Content-Type': 'application/json',
          'X-Bridge-Timestamp': ts,
          'X-Bridge-Signature': b64(await hmac('SHA-256', 'bridge-secret', `${ts}.${url}.${body}`)),
        },
      }
    },
  })),
]

describe('#2627 — does the provider\'s webhook authentication cover the query string?', () => {
  for (const scheme of schemes) {
    describe(scheme.name, () => {
      it('accepts the callback it genuinely signed (the fixture is a valid signature)', async () => {
        const s = await scheme.sign(GENUINE)
        const req = new Request(s.url, { method: 'POST', headers: s.headers, body: s.body })
        expect(await scheme.adapter.validateWebhook(req)).toBe(true)
      })

      it(scheme.covers
        ? 'refuses the same callback replayed with its query changed'
        : 'STILL VERIFIES with its query changed — the query is unauthenticated, so no route may read a call or hub from it', async () => {
        const s = await scheme.sign(GENUINE)
        // The genuine signed URL, plus one parameter the provider never sent.
        const req = new Request(`${s.url}&parentCallSid=someone-elses-call`, { method: 'POST', headers: s.headers, body: s.body })
        expect(await scheme.adapter.validateWebhook(req)).toBe(!scheme.covers)
      })
    })
  }
})
