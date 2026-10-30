/**
 * Untranslated-value detector (#2335).
 *
 * `bun run i18n:validate` proves a key is PRESENT in every locale. It cannot
 * prove the value was ever translated: `deferred.json` records "this locale
 * knowingly carries English here", but anyone can add a line to it, so a new
 * English copy passes the moment it is recorded. This module measures the
 * thing the gate was assumed to measure -- a locale value that is byte-
 * identical to `en.json` -- and gates on the part of it a PR can still stop.
 *
 *   - **Blocking**: a pair (key x locale) that this change adds or alters, and
 *     whose value is verbatim English. Recording it in `deferred.json` does not
 *     excuse it -- deferral is for the backlog that exists, not for new debt.
 *   - **Reported**: the whole backlog, per locale, so the number is visible on
 *     every run and cannot quietly grow.
 *
 * "Adds or alters" is derived from the merge base (see `check-untranslated.ts`),
 * never from a committed snapshot.
 *
 * A value identical to English is NOT untranslated when:
 *   - it contains no letters once `{{placeholders}}` are removed (digits,
 *     punctuation, a bare `{{count}}`); or
 *   - the locale file lists the key in its top-level `_same_as_en` array -- the
 *     reviewable, per-key, per-locale statement that the English text is the
 *     correct text (a brand name, a protocol term, a true loanword).
 *
 * `languages.ts` defines no regional variants (every code is a distinct
 * language), so there is no variant exemption.
 */

import { flattenKeysDotted } from './deferral'

/** Top-level member of a locale file: dotted en.json keys whose English text is correct here. */
export const SAME_AS_EN_KEY = '_same_as_en'

/** Dotted key prefixes whose strings are heard or read by callers, reported on their own. */
export const CALLER_FACING_PREFIXES = ['voice.', 'ivr.'] as const

/** `{{name}}` interpolation, as written in the locale sources. */
const PLACEHOLDER = /\{\{[^}]*\}\}/g

/** True when the value says something in a language: at least one letter outside placeholders. */
export function hasLetters(value: string): boolean {
  return /\p{L}/u.test(value.replace(PLACEHOLDER, ''))
}

export interface SameAsEn {
  keys: Set<string>
  errors: string[]
}

/** Read the `_same_as_en` marker out of a parsed locale file. */
export function readSameAsEn(locale: string, data: Record<string, unknown>): SameAsEn {
  const raw = data[SAME_AS_EN_KEY]
  if (raw === undefined) return { keys: new Set(), errors: [] }
  if (!Array.isArray(raw) || raw.some(k => typeof k !== 'string' || k.length === 0)) {
    return { keys: new Set(), errors: [`${locale}: "${SAME_AS_EN_KEY}" must be an array of non-empty dotted en.json keys`] }
  }
  const errors: string[] = []
  const keys = new Set<string>()
  for (const key of raw as string[]) {
    if (keys.has(key)) errors.push(`${locale}: duplicate "${SAME_AS_EN_KEY}" entry "${key}"`)
    keys.add(key)
  }
  return { keys, errors }
}

/**
 * A marker that does not describe the data is rot: it must name a key en.json
 * has, the locale must actually carry the English text there, and the text must
 * have letters (a letterless value never needs excusing).
 */
export function checkSameAsEnHygiene(
  locale: string,
  marker: ReadonlySet<string>,
  enFlat: Record<string, string>,
  localeFlat: Record<string, string>
): string[] {
  const errors: string[] = []
  for (const key of [...marker].sort()) {
    const en = enFlat[key]
    if (en === undefined) {
      errors.push(`${locale}: "${SAME_AS_EN_KEY}" lists "${key}", which en.json no longer has`)
    } else if (localeFlat[key] !== en) {
      errors.push(`${locale}: "${SAME_AS_EN_KEY}" lists "${key}", but ${locale}.json holds a different value -- remove the marker`)
    } else if (!hasLetters(en)) {
      errors.push(`${locale}: "${SAME_AS_EN_KEY}" lists "${key}", which has no letters and never needs a marker -- remove it`)
    }
  }
  return errors
}

export function isUntranslated(key: string, enValue: string, value: string | undefined, marker: ReadonlySet<string>): boolean {
  return value === enValue && hasLetters(enValue) && !marker.has(key)
}

/** One locale's flattened strings plus its parsed marker. */
export interface LocaleSnapshot {
  flat: Record<string, string>
  sameAsEn: ReadonlySet<string>
}

export interface CatalogueSnapshot {
  en: Record<string, string>
  /** locale code -> snapshot. A locale that does not exist in this snapshot is absent. */
  locales: Map<string, LocaleSnapshot>
}

export function snapshotFromJson(enData: Record<string, unknown>, localeData: Map<string, Record<string, unknown>>): {
  snapshot: CatalogueSnapshot
  errors: string[]
} {
  const errors: string[] = []
  const locales = new Map<string, LocaleSnapshot>()
  for (const [locale, data] of localeData) {
    const marker = readSameAsEn(locale, data)
    errors.push(...marker.errors)
    locales.set(locale, { flat: flattenKeysDotted(data), sameAsEn: marker.keys })
  }
  return { snapshot: { en: flattenKeysDotted(enData), locales }, errors }
}

export interface LocaleReport {
  locale: string
  /** Pairs whose value is verbatim English and need translating (the backlog). */
  untranslated: string[]
  /** The subset of `untranslated` under a caller-facing prefix. */
  callerFacing: string[]
  /** Pairs the marker declares correct-as-English. */
  declaredSame: number
  /** Present only when the locale existed at the base: pairs this change adds or alters that are untranslated. */
  introduced: string[]
  /** False when the locale file does not exist at the base (a brand-new locale has no baseline). */
  hadBaseline: boolean
}

export interface UntranslatedReport {
  perLocale: LocaleReport[]
  /** Keys untranslated in every non-English locale. */
  untranslatedEverywhere: string[]
  errors: string[]
}

/**
 * Compare the current catalogue against its merge-base snapshot.
 *
 * A pair (key, locale) is touched by the change when the key is new to en.json,
 * its English text changed, the key is new to the locale file, or the locale's
 * value changed. Only touched, untranslated pairs are `introduced`.
 */
export function analyse(current: CatalogueSnapshot, base: CatalogueSnapshot): UntranslatedReport {
  const errors: string[] = []
  const perLocale: LocaleReport[] = []
  let everywhere: Set<string> | undefined

  for (const locale of [...current.locales.keys()].sort()) {
    const cur = current.locales.get(locale)!
    const prev = base.locales.get(locale)
    errors.push(...checkSameAsEnHygiene(locale, cur.sameAsEn, current.en, cur.flat))

    const untranslated: string[] = []
    const introduced: string[] = []
    let declaredSame = 0
    for (const [key, enValue] of Object.entries(current.en)) {
      const value = cur.flat[key]
      if (value === undefined) continue // absent keys are the presence gate's business, not this one's
      if (value === enValue && hasLetters(enValue) && cur.sameAsEn.has(key)) declaredSame++
      if (!isUntranslated(key, enValue, value, cur.sameAsEn)) continue
      untranslated.push(key)
      if (!prev) continue
      const touched =
        base.en[key] !== enValue || prev.flat[key] === undefined || prev.flat[key] !== value
      if (touched) introduced.push(key)
    }

    perLocale.push({
      locale,
      untranslated,
      callerFacing: untranslated.filter(k => CALLER_FACING_PREFIXES.some(p => k.startsWith(p))),
      declaredSame,
      introduced,
      hadBaseline: prev !== undefined,
    })
    const mine = new Set(untranslated)
    everywhere = everywhere ? new Set([...everywhere].filter(k => mine.has(k))) : mine
  }

  return { perLocale, untranslatedEverywhere: [...(everywhere ?? [])].sort(), errors }
}

/** Markdown report: the per-locale backlog table, then every blocking pair. */
export function renderReport(report: UntranslatedReport, baseLabel: string): string {
  const lines: string[] = []
  const total = report.perLocale.reduce((n, l) => n + l.untranslated.length, 0)
  const introduced = report.perLocale.reduce((n, l) => n + l.introduced.length, 0)
  lines.push('### i18n: untranslated values (byte-identical to `en.json`)')
  lines.push('')
  lines.push(`Compared against merge base \`${baseLabel}\`.`)
  lines.push('')
  lines.push('| locale | untranslated (backlog) | of which voice.* / ivr.* | declared `_same_as_en` | introduced by this change |')
  lines.push('|---|---:|---:|---:|---:|')
  for (const l of report.perLocale) {
    const intro = l.hadBaseline ? String(l.introduced.length) : 'new locale (no baseline)'
    lines.push(`| ${l.locale} | ${l.untranslated.length} | ${l.callerFacing.length} | ${l.declaredSame} | ${intro} |`)
  }
  lines.push(`| **total** | **${total}** | **${report.perLocale.reduce((n, l) => n + l.callerFacing.length, 0)}** | | **${introduced}** |`)
  lines.push('')
  lines.push(`Keys untranslated in all ${report.perLocale.length} non-English locales: **${report.untranslatedEverywhere.length}**.`)
  if (introduced > 0) {
    lines.push('')
    lines.push('#### Blocking: untranslated values introduced by this change')
    lines.push('')
    for (const l of report.perLocale) {
      for (const key of l.introduced) lines.push(`- \`${l.locale}\` \`${key}\``)
    }
    lines.push('')
    lines.push(
      'Translate each value. If the English text is genuinely correct in that locale, list the key in that locale\'s top-level ' +
      `\`${SAME_AS_EN_KEY}\` array. Adding it to \`deferred.json\` does not excuse a new or changed value.`
    )
  }
  if (report.errors.length > 0) {
    lines.push('')
    lines.push('#### Blocking: invalid `_same_as_en` markers')
    lines.push('')
    for (const e of report.errors) lines.push(`- ${e}`)
  }
  return lines.join('\n') + '\n'
}

export function isFailing(report: UntranslatedReport): boolean {
  return report.errors.length > 0 || report.perLocale.some(l => l.introduced.length > 0)
}
