/**
 * Replay keys cover exactly what each provider's signature authenticates (#2179).
 *
 * Twilio and Plivo post byte-identical bodies for two CAPTCHA timeouts on one
 * call, so a body-only key dropped the second as a replay. Keying on the whole
 * URL instead would let a captured Plivo or Bandwidth request be replayed with
 * an unsigned query parameter changed. Each adapter's key is therefore built
 * from its own signing rule — asserted here against requests that pass that
 * adapter's real `validateWebhook`.
 */
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { TwilioAdapter } from '@worker/telephony/twilio'
import { PlivoAdapter } from '@worker/telephony/plivo'
import { BandwidthAdapter } from '@worker/telephony/bandwidth'

const BODY = 'CallSid=CA123&From=%2B15551111111&To=%2B15550000000'
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' }

function twilioSigned(url: string, token: string): Request {
  const params = [...new URLSearchParams(BODY).entries()].sort(([a], [b]) => a.localeCompare(b))
  const data = url + params.map(([k, v]) => k + v).join('')
  const signature = createHmac('sha1', token).update(data).digest('base64')
  return new Request(url, { method: 'POST', headers: { ...FORM, 'X-Twilio-Signature': signature }, body: BODY })
}

function plivoSigned(url: string, token: string, nonce: string): Request {
  const u = new URL(url)
  const params = [...new URLSearchParams(BODY).entries()].sort(([a], [b]) => a.localeCompare(b))
  const data = u.origin + u.pathname + params.map(([k, v]) => k + v).join('') + '.' + nonce
  const signature = createHmac('sha256', token).update(data).digest('base64')
  return new Request(url, {
    method: 'POST',
    headers: { ...FORM, 'X-Plivo-Signature-V3': signature, 'X-Plivo-Signature-V3-Nonce': nonce },
    body: BODY,
  })
}

describe('webhookReplayKey', () => {
  it('Twilio: two identical bodies on different CAPTCHA rounds are different events', async () => {
    const twilio = new TwilioAdapter('AC1', 'tw-token', '+15550000000')
    const round0 = twilioSigned('https://hotline.example/api/telephony/captcha?callSid=CA123&lang=en&round=0', 'tw-token')
    const round1 = twilioSigned('https://hotline.example/api/telephony/captcha?callSid=CA123&lang=en&round=1', 'tw-token')
    expect(await twilio.validateWebhook(round0)).toBe(true)
    expect(await twilio.validateWebhook(round1)).toBe(true)
    expect(await twilio.webhookReplayKey(round0)).not.toBe(await twilio.webhookReplayKey(round1))
    // A true replay is the same key.
    expect(await twilio.webhookReplayKey(round1.clone())).toBe(await twilio.webhookReplayKey(round1))
  })

  it('Plivo: an unsigned query change still validates, so it must not change the key', async () => {
    const plivo = new PlivoAdapter('MA1', 'pl-token', '+15550000000')
    const captured = plivoSigned('https://hotline.example/api/telephony/captcha?callSid=CA123&round=0', 'pl-token', 'nonce-1')
    const tampered = plivoSigned('https://hotline.example/api/telephony/captcha?callSid=CA123&round=7', 'pl-token', 'nonce-1')
    expect(await plivo.validateWebhook(tampered)).toBe(true)
    expect(await plivo.webhookReplayKey(tampered)).toBe(await plivo.webhookReplayKey(captured))
  })

  it('Plivo: two identical bodies with their own signed nonces are different events', async () => {
    const plivo = new PlivoAdapter('MA1', 'pl-token', '+15550000000')
    const first = plivoSigned('https://hotline.example/api/telephony/captcha?callSid=CA123&round=0', 'pl-token', 'nonce-1')
    const second = plivoSigned('https://hotline.example/api/telephony/captcha?callSid=CA123&round=1', 'pl-token', 'nonce-2')
    expect(await plivo.validateWebhook(second)).toBe(true)
    expect(await plivo.webhookReplayKey(first)).not.toBe(await plivo.webhookReplayKey(second))
  })

  it('Twilio: a captured request with its params re-encoded and reordered still validates — and is the same key', async () => {
    const twilio = new TwilioAdapter('AC1', 'tw-token', '+15550000000')
    const url = 'https://hotline.example/api/telephony/captcha?callSid=CA123&lang=en&round=1'
    const captured = twilioSigned(url, 'tw-token')
    const reshaped = new Request(url, {
      method: 'POST',
      headers: { ...FORM, 'X-Twilio-Signature': captured.headers.get('X-Twilio-Signature') ?? '' },
      body: 'To=%2B15550000000&From=%2b15551111111&Call%53id=CA123',
    })
    expect(await twilio.validateWebhook(reshaped)).toBe(true)
    expect(await twilio.webhookReplayKey(reshaped)).toBe(await twilio.webhookReplayKey(captured))
  })

  it('Bandwidth: basic auth binds nothing in the URL, so the key is the body alone', async () => {
    const bandwidth = new BandwidthAdapter('acct', 'user', 'pass', 'app', '+15550000000')
    const auth = { Authorization: `Basic ${btoa('user:pass')}`, 'Content-Type': 'application/json' }
    const body = JSON.stringify({ eventType: 'gather', digits: '', eventTime: '2026-10-30T10:00:00Z' })
    const a = new Request('https://hotline.example/api/telephony/captcha?round=0', { method: 'POST', headers: auth, body })
    const b = new Request('https://hotline.example/api/telephony/captcha?round=9', { method: 'POST', headers: auth, body })
    expect(await bandwidth.validateWebhook(b)).toBe(true)
    expect(await bandwidth.webhookReplayKey(a)).toBe(await bandwidth.webhookReplayKey(b))
  })
})
