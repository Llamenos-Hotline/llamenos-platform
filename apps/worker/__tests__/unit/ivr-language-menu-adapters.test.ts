/**
 * #657 — the IVR language menu each adapter emits may only offer languages the
 * provider has a real voice for. These tests drive the adapters end to end
 * (hub language list in → provider document out) and assert on what a caller
 * would actually hear.
 */
import { describe, it, expect } from 'vitest'
import { TwilioAdapter } from '@worker/telephony/twilio'
import { AsteriskAdapter } from '@worker/telephony/asterisk'
import { IVR_PROMPTS, resolveIvrPrompt } from '@shared/voice-prompts'
import { fakeSpeech, spoken } from '../helpers/fake-speech'

const baseParams = { callSid: 'CA1', callerNumber: '+15550000000', hotlineName: 'Test' }

function twilio() {
  return new TwilioAdapter('AC1', 'token', '+15551234567')
}

function asterisk() {
  return new AsteriskAdapter('http://ari', 'u', 'p', '+15551234567', 'http://cb', 'secret')
}

/** Every `<Say language="…">text</Say>` in a TwiML document, in document order. */
function twimlSays(body: string): Array<{ voice: string; text: string }> {
  return [...body.matchAll(/<Say language="([^"]+)">([^<]*)<\/Say>/g)].map(m => ({ voice: m[1], text: m[2] }))
}

describe('Twilio IVR language menu (#657)', () => {
  it('does not offer Haitian Creole, which Twilio has no voice for', async () => {
    const res = await twilio().handleLanguageMenu({ ...baseParams, enabledLanguages: ['es', 'ht', 'zh'] })
    const says = twimlSays(res.body)
    // Two options, neither of them Kreyòl read aloud by a French voice.
    expect(says).toHaveLength(2)
    expect(says.map(s => s.voice)).toEqual(['es-MX', 'cmn-CN'])
    expect(res.body).not.toContain('fr-FR')
  })

  it('keeps each language on the digit its hub position assigns, so dropping one never shifts another', async () => {
    const res = await twilio().handleLanguageMenu({ ...baseParams, enabledLanguages: ['es', 'ht', 'zh'] })
    const says = twimlSays(res.body)
    expect(says[0].text).toBe(resolveIvrPrompt(IVR_PROMPTS.es, '1'))
    // zh is hub position 3 → digit 3, exactly what languageFromDigit('3', hubLanguages) resolves.
    expect(says[1].text).toBe(resolveIvrPrompt(IVR_PROMPTS.zh, '3'))
  })

  it('skips the menu and forces the only speakable language when the intersection has one entry', async () => {
    const res = await twilio().handleLanguageMenu({ ...baseParams, enabledLanguages: ['ht', 'es'] })
    expect(res.body).not.toContain('<Gather')
    expect(res.body).toContain('forceLang=es')
  })

  it('never offers an eleventh language on a digit the route cannot resolve (no broken "more" menu)', async () => {
    const hub = ['en', 'es', 'zh', 'tl', 'vi', 'ar', 'fr', 'ko', 'ru', 'hi', 'pt', 'de']
    const res = await twilio().handleLanguageMenu({ ...baseParams, enabledLanguages: hub })
    const says = twimlSays(res.body)
    expect(says.map(s => s.voice)).toEqual([
      'en-US', 'es-MX', 'cmn-CN', 'fil-PH', 'vi-VN', 'ar-XA', 'fr-FR', 'ko-KR', 'ru-RU', 'hi-IN',
    ])
    expect(says[9].text).toBe(resolveIvrPrompt(IVR_PROMPTS.hi, '0'))
  })
})

describe('Asterisk IVR language menu (#657)', () => {
  it('does not offer Tagalog, which generated speech has no voice for — and keeps the other digits', async () => {
    const res = await asterisk().handleLanguageMenu({ ...baseParams, enabledLanguages: ['en', 'tl', 'es'], speechUrl: fakeSpeech })
    const { commands } = JSON.parse(res.body) as { commands: Array<{ action: string; url?: string }> }
    const announced = commands.filter((c) => c.action === 'play').map((c) => spoken(c.url!))
    expect(announced).toEqual([
      { locale: 'en', text: resolveIvrPrompt(IVR_PROMPTS.en, '1') },
      { locale: 'es', text: resolveIvrPrompt(IVR_PROMPTS.es, '3') },
    ])
  })
})
