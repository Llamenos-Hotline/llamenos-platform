/**
 * Deferral record — the three-state i18n completeness gate.
 *
 * Every key x locale pair is in exactly one of three states:
 *
 *   - **missing**    — the key is absent from the locale file. Always an error.
 *   - **deferred**   — the value is verbatim English AND the pair is listed in
 *                      `packages/i18n/deferred.json`. Deliberate, reviewable,
 *                      and counted separately so translation progress is legible.
 *   - **translated** — the value differs from English (and is not recorded).
 *
 * The record is what makes "present" distinguishable from "translated": a
 * locale value that happens to equal the English source is NOT deferred unless
 * the record says so. An English copy with no record entry is the regression
 * the old presence-only gate could not see, and it fails validation. A
 * translated value whose record entry was left behind also fails, so the
 * record cannot rot — removing the entry is the only thing a translator has
 * to do besides supplying the text.
 *
 * Record keys are dotted en.json paths (e.g. `admin.activeInvitesHeader`),
 * the same addressing translators use in the locale files. Both gate entry
 * points — i18n-codegen.ts (`bun run i18n:validate`) and validate-strings.ts
 * (`bun run i18n:validate:all`, the CI gate) — classify through this module.
 */

import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export const DEFERRED_RECORD_PATH = resolve(__dirname, '../deferred.json')

/** locale code -> set of dotted en.json paths recorded as deferred. */
export type DeferralRecord = Map<string, Set<string>>

/** Flatten nested locale JSON to dot-separated en.json paths. */
export function flattenKeysDotted(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      Object.assign(result, flattenKeysDotted(value as Record<string, unknown>, fullKey))
    } else if (typeof value === 'string') {
      result[fullKey] = value
    }
  }
  return result
}

export interface ParsedRecord {
  record: DeferralRecord
  errors: string[]
}

/** Structural validation of the record file's parsed JSON. */
export function parseDeferralRecord(raw: unknown): ParsedRecord {
  const errors: string[] = []
  const record: DeferralRecord = new Map()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { record, errors: ['deferred.json must be a JSON object with a "locales" member'] }
  }
  const locales = (raw as Record<string, unknown>).locales
  if (typeof locales !== 'object' || locales === null || Array.isArray(locales)) {
    return { record, errors: ['deferred.json must have a "locales" object keyed by locale code'] }
  }
  for (const [locale, keys] of Object.entries(locales as Record<string, unknown>)) {
    if (locale === 'en') {
      errors.push('"en" must not appear in the deferral record — it is the source locale')
      continue
    }
    if (!Array.isArray(keys) || keys.some(k => typeof k !== 'string' || k.length === 0)) {
      errors.push(`${locale}: deferral entries must be an array of non-empty dotted en.json key paths`)
      continue
    }
    const seen = new Set<string>()
    for (const key of keys as string[]) {
      if (seen.has(key)) errors.push(`${locale}: duplicate deferral entry "${key}"`)
      seen.add(key)
    }
    record.set(locale, seen)
  }
  return { record, errors }
}

export function loadDeferralRecord(path: string = DEFERRED_RECORD_PATH): ParsedRecord {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (e) {
    return { record: new Map(), errors: [`cannot read deferral record at ${path}: ${(e as Error).message}`] }
  }
  return parseDeferralRecord(raw)
}

/**
 * Cross-check the record against the catalogue. Deferred means "present,
 * knowingly English" — so an entry referencing a key en.json no longer has,
 * a locale file that does not exist, or a key the locale file does not carry
 * is record rot and fails the gate.
 */
export function checkRecordHygiene(
  record: DeferralRecord,
  enKeys: ReadonlySet<string>,
  localeKeys: ReadonlyMap<string, ReadonlySet<string>>
): string[] {
  const errors: string[] = []
  for (const locale of [...record.keys()].sort()) {
    const keys = record.get(locale) ?? new Set<string>()
    const present = localeKeys.get(locale)
    if (!present) {
      errors.push(`deferral record lists "${locale}" but packages/i18n/locales/${locale}.json does not exist`)
      continue
    }
    for (const key of [...keys].sort()) {
      if (!enKeys.has(key)) {
        errors.push(`${locale}: deferred key "${key}" no longer exists in en.json — remove it from deferred.json`)
      } else if (!present.has(key)) {
        errors.push(
          `${locale}: deferred key "${key}" is absent from the locale file — deferred means "present, knowingly English"; ` +
          `either restore the key in ${locale}.json or remove the record entry`
        )
      }
    }
  }
  return errors
}

export interface LocaleClassification {
  /** en keys absent from the locale file. */
  missing: string[]
  /** values differing from en, not recorded. */
  translated: string[]
  /** values identical to en, recorded in deferred.json. */
  deferred: string[]
  /** values identical to en, NOT recorded — the regression case. */
  unrecordedEnglish: string[]
  /** values differing from en but still recorded — record rot. */
  staleDeferral: string[]
}

/**
 * Classify every en key for one locale. All key sets are dotted en.json paths.
 * `sameAsEn` is the locale's `_same_as_en` marker (see untranslated.ts): an
 * English-identical value it lists is a verified-correct translation, so it
 * counts as translated and needs no deferral entry.
 */
export function classifyLocale(
  enFlat: Record<string, string>,
  localeFlat: Record<string, string>,
  deferredKeys: ReadonlySet<string>,
  sameAsEn: ReadonlySet<string> = new Set()
): LocaleClassification {
  const c: LocaleClassification = { missing: [], translated: [], deferred: [], unrecordedEnglish: [], staleDeferral: [] }
  for (const [key, enValue] of Object.entries(enFlat)) {
    const value = localeFlat[key]
    if (value === undefined) {
      c.missing.push(key)
    } else if (value === enValue && sameAsEn.has(key)) {
      c.translated.push(key)
    } else if (value === enValue) {
      if (deferredKeys.has(key)) c.deferred.push(key)
      else c.unrecordedEnglish.push(key)
    } else {
      if (deferredKeys.has(key)) c.staleDeferral.push(key)
      else c.translated.push(key)
    }
  }
  return c
}

/**
 * Recompute one locale's deferral entries from scratch: every en key whose
 * locale value is verbatim English becomes the entry set; everything else is
 * dropped (translated keys, keys en no longer has). Running this is the
 * deliberate, diffable act that records "this locale knowingly carries
 * English here" — e.g. right after `cp en.json <new-locale>.json`.
 */
export function syncLocaleDeferrals(
  enFlat: Record<string, string>,
  localeFlat: Record<string, string>,
  previous: ReadonlySet<string>
): { keys: Set<string>; added: number; removed: number } {
  const next = new Set<string>()
  let added = 0
  for (const [key, enValue] of Object.entries(enFlat)) {
    if (localeFlat[key] === enValue) {
      next.add(key)
      if (!previous.has(key)) added++
    }
  }
  const removed = [...previous].filter(k => !next.has(k)).length
  return { keys: next, added, removed }
}

const RECORD_HEADER = [
  'Deferral record for the three-state i18n gate (missing / deferred / translated).',
  'Each entry asserts: this locale knowingly carries the verbatim English text for this',
  'dotted en.json key. An English-identical value NOT listed here fails i18n validation',
  '(it is indistinguishable from a regression), and a translated value still listed here',
  'also fails — translators remove the entry when they supply the text.',
  'Seed note: generated with `bun run i18n:codegen --sync-deferral`. It includes the',
  '385 reviewed pairs from issue #1911 (55 keys x am, ku, mix, my, quc, de, tl) plus',
  'every other English-identical pair measured in the catalogue (see issue #1912 — the',
  'same convention of copying en verbatim into lagging locales produced them).',
  'Maintain via `bun run i18n:codegen --sync-deferral` or by hand; keep arrays sorted.',
]

/** Serialize sorted: locale codes alphabetical, keys alphabetical, one per line. */
export function serializeDeferralRecord(record: DeferralRecord): string {
  const locales: Record<string, string[]> = {}
  for (const locale of [...record.keys()].sort()) {
    const keys = [...(record.get(locale) ?? [])].sort()
    if (keys.length > 0) locales[locale] = keys
  }
  return JSON.stringify({ $comment: RECORD_HEADER, locales }, null, 2) + '\n'
}
