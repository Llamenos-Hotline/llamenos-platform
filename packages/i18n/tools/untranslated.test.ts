import { describe, expect, it } from 'vitest'
import { classifyLocale } from './deferral'
import {
  analyse,
  hasLetters,
  isFailing,
  readSameAsEn,
  renderReport,
  snapshotFromJson,
  type CatalogueSnapshot,
} from './untranslated'

function catalogue(en: Record<string, unknown>, locales: Record<string, Record<string, unknown>>): CatalogueSnapshot {
  const { snapshot, errors } = snapshotFromJson(en, new Map(Object.entries(locales)))
  expect(errors).toEqual([])
  return snapshot
}

const BASE_EN = { greeting: 'Hello there', save: 'Save changes', count: '{{count}}', nav: { home: 'Home page' } }
const BASE_ES = { greeting: 'Hola', save: 'Guardar cambios', count: '{{count}}', nav: { home: 'Home page' } }

describe('hasLetters', () => {
  it.each([
    ['{{count}}', false],
    ['{{count}} / {{total}}', false],
    ['42%', false],
    ['—', false],
    ['{{count}} items', true],
    ['OK', true],
    ['中文', true],
  ])('%s -> %s', (value, expected) => {
    expect(hasLetters(value)).toBe(expected)
  })
})

describe('analyse', () => {
  const base = catalogue(BASE_EN, { es: BASE_ES })

  it('passes and reports the untouched backlog', () => {
    const report = analyse(base, base)
    expect(isFailing(report)).toBe(false)
    // nav.home is verbatim English: backlog, reported, not blocking. count is letterless.
    expect(report.perLocale[0]).toMatchObject({ locale: 'es', untranslated: ['nav.home'], introduced: [] })
    expect(renderReport(report, 'abc')).toContain('| es | 1 |')
  })

  it('FAILS a new key whose English text is copied into a locale, naming key and locale', () => {
    const current = catalogue(
      { ...BASE_EN, newKey: 'Brand new string' },
      { es: { ...BASE_ES, newKey: 'Brand new string' } }
    )
    const report = analyse(current, base)
    expect(isFailing(report)).toBe(true)
    expect(report.perLocale[0].introduced).toEqual(['newKey'])
    expect(renderReport(report, 'abc')).toContain('- `es` `newKey`')
  })

  it('passes a new key that is properly translated', () => {
    const current = catalogue(
      { ...BASE_EN, newKey: 'Brand new string' },
      { es: { ...BASE_ES, newKey: 'Cadena nueva' } }
    )
    const report = analyse(current, base)
    expect(isFailing(report)).toBe(false)
    expect(report.perLocale[0].introduced).toEqual([])
  })

  it('does not excuse a new English copy because it is listed in deferred.json (the gate never reads it)', () => {
    const current = catalogue(
      { ...BASE_EN, newKey: 'Brand new string' },
      { es: { ...BASE_ES, newKey: 'Brand new string' } }
    )
    expect(isFailing(analyse(current, base))).toBe(true)
  })

  it('fails an existing key whose translation is overwritten with English', () => {
    const current = catalogue(BASE_EN, { es: { ...BASE_ES, save: 'Save changes' } })
    expect(analyse(current, base).perLocale[0].introduced).toEqual(['save'])
  })

  it('fails a changed English source whose locale copy is re-synced to the new English', () => {
    const current = catalogue({ ...BASE_EN, nav: { home: 'Home screen' } }, { es: { ...BASE_ES, nav: { home: 'Home screen' } } })
    expect(analyse(current, base).perLocale[0].introduced).toEqual(['nav.home'])
  })

  it('passes a changed English source whose locale keeps a real translation', () => {
    const current = catalogue({ ...BASE_EN, greeting: 'Hello, friend' }, { es: BASE_ES })
    expect(isFailing(analyse(current, base))).toBe(false)
  })

  it('passes a new letterless value copied verbatim', () => {
    const current = catalogue({ ...BASE_EN, pct: '{{value}}%' }, { es: { ...BASE_ES, pct: '{{value}}%' } })
    expect(isFailing(analyse(current, base))).toBe(false)
  })

  it('passes a new identical value declared in _same_as_en, and counts it as declared', () => {
    const current = catalogue(
      { ...BASE_EN, brand: 'Llámenos' },
      { es: { ...BASE_ES, brand: 'Llámenos', _same_as_en: ['brand'] } }
    )
    const report = analyse(current, base)
    expect(isFailing(report)).toBe(false)
    expect(report.perLocale[0].declaredSame).toBe(1)
  })

  it('fails a _same_as_en marker the data contradicts', () => {
    const translated = catalogue(BASE_EN, { es: { ...BASE_ES, _same_as_en: ['greeting'] } })
    const gone = catalogue(BASE_EN, { es: { ...BASE_ES, _same_as_en: ['nope'] } })
    const letterless = catalogue(BASE_EN, { es: { ...BASE_ES, _same_as_en: ['count'] } })
    for (const c of [translated, gone, letterless]) {
      const report = analyse(c, base)
      expect(report.errors).toHaveLength(1)
      expect(isFailing(report)).toBe(true)
    }
  })

  it('reports a locale that does not exist at the base as having no baseline instead of failing it', () => {
    const current = catalogue(BASE_EN, { es: BASE_ES, fr: { ...BASE_EN } })
    const report = analyse(current, base)
    const fr = report.perLocale.find(l => l.locale === 'fr')!
    expect(fr.hadBaseline).toBe(false)
    expect(fr.untranslated.length).toBeGreaterThan(0)
    expect(isFailing(report)).toBe(false)
    expect(renderReport(report, 'abc')).toContain('new locale (no baseline)')
  })

  it('counts keys untranslated in every locale', () => {
    const current = catalogue(BASE_EN, { es: BASE_ES, fr: { ...BASE_EN, greeting: 'Bonjour' } })
    expect(analyse(current, current).untranslatedEverywhere).toEqual(['nav.home'])
  })

  it('splits out caller-facing voice.* / ivr.* backlog', () => {
    const en = { voice: { hold: 'Please hold' }, ivr: { menu: 'Press one' }, other: 'Other text' }
    const snap = catalogue(en, { es: { ...en } })
    expect(analyse(snap, snap).perLocale[0].callerFacing).toEqual(['voice.hold', 'ivr.menu'])
  })
})

describe('readSameAsEn', () => {
  it('rejects a malformed marker', () => {
    expect(readSameAsEn('es', { _same_as_en: 'brand' }).errors).toHaveLength(1)
    expect(readSameAsEn('es', { _same_as_en: ['a', 'a'] }).errors).toHaveLength(1)
    expect(readSameAsEn('es', {}).errors).toEqual([])
  })
})

describe('classifyLocale with _same_as_en', () => {
  it('treats a declared-identical value as translated, not as unrecorded English', () => {
    const c = classifyLocale({ brand: 'Llámenos' }, { brand: 'Llámenos' }, new Set(), new Set(['brand']))
    expect(c.translated).toEqual(['brand'])
    expect(c.unrecordedEnglish).toEqual([])
  })
  it('still flags an undeclared identical value', () => {
    const c = classifyLocale({ brand: 'Llámenos' }, { brand: 'Llámenos' }, new Set())
    expect(c.unrecordedEnglish).toEqual(['brand'])
  })
})
