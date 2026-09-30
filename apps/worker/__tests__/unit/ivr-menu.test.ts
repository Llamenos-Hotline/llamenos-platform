/**
 * #657 — buildIvrLanguageMenu / IvrVoiceCatalog: determinism guards.
 */
import { describe, it, expect } from 'vitest'
import { IvrVoiceCatalog, buildIvrLanguageMenu } from '@worker/telephony/ivr-menu'
import { TWILIO_VOICES } from '@worker/telephony/twilio'
import { VONAGE_VOICES } from '@worker/telephony/vonage'
import { PLIVO_VOICES } from '@worker/telephony/plivo'
import { TELNYX_VOICES } from '@worker/telephony/telnyx'
import { BANDWIDTH_VOICES } from '@worker/telephony/bandwidth'
import { ASTERISK_VOICES } from '@worker/telephony/asterisk'
import { FREESWITCH_VOICES } from '@worker/telephony/freeswitch'
import { LANGUAGE_CODES } from '@shared/languages'
import { IVR_PROMPTS, resolveIvrPrompt } from '@shared/voice-prompts'

const catalog = new IvrVoiceCatalog<string>('test', [
  ['en', 'voice-en'],
  ['es', 'voice-es'],
  ['pt', 'voice-pt'],
  ['zh', 'voice-zh'],
])

function menuSummary(hub: readonly string[], cat: IvrVoiceCatalog<unknown> = catalog) {
  const menu = buildIvrLanguageMenu(hub, cat)
  return menu.kind === 'single' ? menu : { kind: menu.kind, options: menu.options.map(o => `${o.digit}:${o.language}`) }
}

describe('buildIvrLanguageMenu', () => {
  it('never offers a hub language the provider has no voice for', () => {
    const menu = buildIvrLanguageMenu(['es', 'ku', 'en', 'ht'], catalog)
    expect(menu.kind).toBe('menu')
    if (menu.kind !== 'menu') return
    expect(menu.options.map(o => o.language)).toEqual(['es', 'en'])
  })

  it('does not infer a voice by prefix or tag negotiation', () => {
    // Catalog declares 'pt' and 'zh' only. A catalog keyed by region tags must not
    // match their bare codes, and a bare code must not match a longer one.
    const tagged = new IvrVoiceCatalog<string>('tagged', [['en', 'en'], ['quc', 'quc-voice']])
    expect(tagged.voiceFor('qu')).toBeUndefined()
    expect(catalog.voiceFor('pt-BR')).toBeUndefined()
    expect(catalog.voiceFor('zh-CN')).toBeUndefined()
    expect(catalog.voiceFor('EN')).toBeUndefined()
    expect(menuSummary(['pt-BR', 'zh-CN', 'EN'])).toEqual({ kind: 'single', language: 'en' })
  })

  it('does not treat Object.prototype keys as voices', () => {
    expect(catalog.voiceFor('constructor')).toBeUndefined()
    expect(catalog.voiceFor('__proto__')).toBeUndefined()
  })

  it('pins menu order and digits for a fixed provider and hub list', () => {
    expect(menuSummary(['zh', 'ku', 'es', 'ht', 'en', 'pt'])).toEqual({
      kind: 'menu',
      options: ['1:zh', '3:es', '5:en', '6:pt'],
    })
  })

  it('assigns each language the digit the /language-selected route resolves (hub position), independent of provider coverage', () => {
    const hub = ['es', 'ku', 'en']
    const narrow = new IvrVoiceCatalog<string>('narrow', [['en', 'x'], ['es', 'x']])
    const wide = new IvrVoiceCatalog<string>('wide', [['en', 'x'], ['es', 'x'], ['ku', 'x']])
    expect(menuSummary(hub, narrow)).toEqual({ kind: 'menu', options: ['1:es', '3:en'] })
    // Adding a voice for ku adds an option; it never moves es or en.
    expect(menuSummary(hub, wide)).toEqual({ kind: 'menu', options: ['1:es', '2:ku', '3:en'] })
  })

  it('is independent of the provider catalog declaration order', () => {
    const reversed = new IvrVoiceCatalog<string>('reversed', [['zh', 'a'], ['pt', 'b'], ['es', 'c'], ['en', 'd']])
    expect(menuSummary(['en', 'es', 'zh'], reversed)).toEqual(menuSummary(['en', 'es', 'zh']))
  })

  it('carries the provider voice and the digit-resolved self-announcement per option', () => {
    const menu = buildIvrLanguageMenu(['ku', 'es', 'en'], catalog)
    expect(menu).toEqual({
      kind: 'menu',
      options: [
        { language: 'es', digit: '2', voice: 'voice-es', prompt: resolveIvrPrompt(IVR_PROMPTS.es, '2') },
        { language: 'en', digit: '3', voice: 'voice-en', prompt: resolveIvrPrompt(IVR_PROMPTS.en, '3') },
      ],
    })
  })

  it('maps hub position 10 to digit 0 and never offers positions past the keypad', () => {
    const hub = ['ku', 'ku', 'ku', 'ku', 'ku', 'ku', 'ku', 'ku', 'es', 'en', 'zh']
    expect(menuSummary(hub)).toEqual({ kind: 'menu', options: ['9:es', '0:en'] })
  })

  it('skips the menu when exactly one hub language is speakable', () => {
    expect(menuSummary(['ku', 'es', 'ht'])).toEqual({ kind: 'single', language: 'es' })
  })

  describe('empty intersection', () => {
    it('forces the default language when the provider speaks it', () => {
      expect(menuSummary(['ku', 'ht'])).toEqual({ kind: 'single', language: 'en' })
      expect(menuSummary([])).toEqual({ kind: 'single', language: 'en' })
    })

    it("otherwise forces the first language in the provider's declared order", () => {
      const noEnglish = new IvrVoiceCatalog<string>('no-en', [['zh', 'a'], ['es', 'b']])
      expect(menuSummary(['ku'], noEnglish)).toEqual({ kind: 'single', language: 'zh' })
    })

    it('rejects a provider that declares no voices at all', () => {
      expect(() => new IvrVoiceCatalog<string>('empty', [])).toThrow(/at least one voice/)
    })
  })
})

describe('IvrVoiceCatalog guards', () => {
  it('rejects a code that is not a shipped locale', () => {
    expect(() => new IvrVoiceCatalog<string>('bad', [['pt-BR', 'x']])).toThrow(/not a shipped locale/)
  })

  it('rejects duplicate entries', () => {
    expect(() => new IvrVoiceCatalog<string>('dup', [['en', 'a'], ['en', 'b']])).toThrow(/duplicate/)
  })

  it('uses the default-language voice for non-menu prompts in an unspeakable language', () => {
    expect(catalog.voiceForPrompt('ku')).toBe('voice-en')
    expect(catalog.voiceForPrompt('es')).toBe('voice-es')
  })
})

/**
 * The record of current IVR voice coverage, per provider, out of the shipped
 * locales. Changing a provider catalog must update this table deliberately.
 */
describe('provider IVR voice coverage', () => {
  const coverage = {
    twilio: TWILIO_VOICES.languages,
    signalwire: TWILIO_VOICES.languages, // SignalWireAdapter extends TwilioAdapter
    vonage: VONAGE_VOICES.languages,
    plivo: PLIVO_VOICES.languages,
    telnyx: TELNYX_VOICES.languages,
    bandwidth: BANDWIDTH_VOICES.languages,
    asterisk: ASTERISK_VOICES.languages,
    freeswitch: FREESWITCH_VOICES.languages,
  }

  it('matches the recorded coverage table', () => {
    expect(coverage).toEqual({
      twilio: ['en', 'es', 'zh', 'tl', 'vi', 'ar', 'fr', 'ko', 'ru', 'hi', 'pt', 'de'],
      signalwire: ['en', 'es', 'zh', 'tl', 'vi', 'ar', 'fr', 'ko', 'ru', 'hi', 'pt', 'de'],
      vonage: ['en', 'es', 'zh', 'tl', 'vi', 'ar', 'fr', 'ko', 'ru', 'hi', 'pt', 'de'],
      plivo: ['en', 'es', 'zh', 'vi', 'ar', 'fr', 'ko', 'ru', 'hi', 'pt', 'de'],
      telnyx: ['en', 'es', 'zh', 'ar', 'fr', 'ko', 'ru', 'hi', 'pt', 'de'],
      bandwidth: ['en', 'es', 'zh', 'ar', 'fr', 'ko', 'ru', 'hi', 'pt', 'de'],
      // The self-hosted PBXs speak what the worker's espeak-ng generates (#1347).
      asterisk: ['en', 'es', 'zh', 'vi', 'ar', 'fr', 'ht', 'ko', 'ru', 'hi', 'pt', 'de', 'uk', 'fa', 'tr', 'ku', 'am', 'my', 'quc'],
      freeswitch: ['en', 'es', 'zh', 'vi', 'ar', 'fr', 'ht', 'ko', 'ru', 'hi', 'pt', 'de', 'uk', 'fa', 'tr', 'ku', 'am', 'my', 'quc'],
    })
  })

  it('only ever declares shipped locales that have an IVR self-announcement', () => {
    for (const languages of Object.values(coverage)) {
      for (const code of languages) {
        expect(LANGUAGE_CODES).toContain(code)
        expect(IVR_PROMPTS[code]).toBeTruthy()
      }
    }
  })

  it('every provider speaks the default language', () => {
    for (const languages of Object.values(coverage)) expect(languages).toContain('en')
  })
})
