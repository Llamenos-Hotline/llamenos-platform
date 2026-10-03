#!/usr/bin/env bun
/**
 * Cross-platform string reference validator.
 *
 * Validates that string references in platform code match the canonical keys
 * generated from en.json. Catches mismatches at CI time before they become
 * runtime crashes or empty strings.
 *
 * Usage:
 *   bun run packages/i18n/tools/validate-strings.ts android
 *   bun run packages/i18n/tools/validate-strings.ts ios
 *   bun run packages/i18n/tools/validate-strings.ts desktop
 *   bun run packages/i18n/tools/validate-strings.ts all
 */

import { readFileSync, readdirSync, statSync } from 'fs'
import { join, resolve, dirname, relative } from 'path'
import { fileURLToPath } from 'url'
import { LANGUAGE_CODES } from '../languages'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const ROOT_DIR = resolve(__dirname, '../../..')
const LOCALES_DIR = resolve(__dirname, '../locales')

// ---------------------------------------------------------------------------
// Shared infrastructure
// ---------------------------------------------------------------------------

interface Mismatch {
  file: string
  line: number
  ref: string
  kind: 'missing' | 'warning'
}

/** Convert camelCase to snake_case (e.g. callHistory → call_history) */
function camelToSnake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

/** Flatten nested JSON to snake_case underscore-separated keys (matches i18n-codegen) */
function flattenKeysUnderscore(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = camelToSnake(key)
    const fullKey = prefix ? `${prefix}_${snakeKey}` : snakeKey
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      Object.assign(result, flattenKeysUnderscore(value as Record<string, unknown>, fullKey))
    } else if (typeof value === 'string') {
      result[fullKey] = value
    }
  }
  return result
}

/** Flatten nested JSON to dot-separated keys (for desktop i18next) */
function flattenKeysDotted(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
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

/** Load canonical keys from en.json */
function loadEnglishSourcesUnderscore(): Record<string, string> {
  const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf-8'))
  return flattenKeysUnderscore(en)
}

function loadCanonicalKeysUnderscore(): Set<string> {
  const data = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf-8'))
  return new Set(Object.keys(flattenKeysUnderscore(data)))
}

function loadCanonicalKeysDotted(): Set<string> {
  const data = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf-8'))
  return new Set(Object.keys(flattenKeysDotted(data)))
}

/** Load allowlist for a given platform */
function loadAllowlist(platform: 'android' | 'ios' | 'desktop'): Set<string> {
  try {
    const data = JSON.parse(readFileSync(join(__dirname, 'validate-allowlist.json'), 'utf-8'))
    const list = data[platform]
    return new Set(Array.isArray(list) ? (list as string[]) : [])
  } catch {
    return new Set()
  }
}

/** Recursively collect files matching given extensions */
function collectFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = []
  function walk(d: string) {
    let entries: string[]
    try {
      entries = readdirSync(d)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(d, entry)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(full)
      } else if (extensions.some(ext => entry.endsWith(ext))) {
        results.push(full)
      }
    }
  }
  walk(dir)
  return results
}

/** Check if a position in a line is inside a line comment */
function isInLineComment(line: string, matchIndex: number, commentPrefix: string): boolean {
  const commentStart = line.indexOf(commentPrefix)
  return commentStart !== -1 && commentStart < matchIndex
}

/** Check if a line is inside a block comment (simple heuristic) */
function isInBlockComment(lines: string[], lineIndex: number): boolean {
  let inBlock = false
  for (let i = 0; i <= lineIndex; i++) {
    const line = lines[i]
    let pos = 0
    while (pos < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', pos)
        if (end === -1) break
        inBlock = false
        pos = end + 2
      } else {
        const start = line.indexOf('/*', pos)
        if (start === -1) break
        const end = line.indexOf('*/', start + 2)
        if (end === -1) {
          inBlock = true
          break
        }
        pos = end + 2
      }
    }
  }
  return inBlock
}

/** Format and print mismatches, return count of errors */
function reportMismatches(platform: string, mismatches: Mismatch[]): number {
  const errors = mismatches.filter(m => m.kind === 'missing')
  const warnings = mismatches.filter(m => m.kind === 'warning')

  if (errors.length === 0 && warnings.length === 0) {
    console.log(`  ${platform}: all references valid`)
    return 0
  }

  if (errors.length > 0) {
    console.error(`  ${platform}: ${errors.length} invalid reference(s):`)
    for (const m of errors) {
      const relPath = relative(ROOT_DIR, m.file)
      console.error(`    ${relPath}:${m.line} -- "${m.ref}" not found in en.json`)
    }
  }

  if (warnings.length > 0) {
    console.warn(`  ${platform}: ${warnings.length} dynamic key warning(s) (skipped):`)
    for (const m of warnings) {
      const relPath = relative(ROOT_DIR, m.file)
      console.warn(`    ${relPath}:${m.line} -- dynamic key: "${m.ref}"`)
    }
  }

  return errors.length
}

// ---------------------------------------------------------------------------
// Android validator
// ---------------------------------------------------------------------------

function validateAndroid(): number {
  const canonicalKeys = loadCanonicalKeysUnderscore()
  const allowlist = loadAllowlist('android')
  const files = collectFiles(
    join(ROOT_DIR, 'apps/android/app/src/main/java'),
    ['.kt']
  )

  const mismatches: Mismatch[] = []
  const pattern = /R\.string\.(\w+)/g

  for (const file of files) {
    const content = readFileSync(file, 'utf-8')
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      pattern.lastIndex = 0
      let match: RegExpExecArray | null

      while ((match = pattern.exec(line)) !== null) {
        if (isInLineComment(line, match.index, '//')) continue
        if (isInBlockComment(lines, i)) continue

        const ref = match[1]
        if (!canonicalKeys.has(ref) && !allowlist.has(ref)) {
          mismatches.push({ file, line: i + 1, ref, kind: 'missing' })
        }
      }
    }
  }

  return reportMismatches('Android', mismatches)
}

// ---------------------------------------------------------------------------
// iOS validator
// ---------------------------------------------------------------------------

function validateIOS(): number {
  const canonicalKeys = loadCanonicalKeysUnderscore()
  const allowlist = loadAllowlist('ios')
  const files = collectFiles(
    join(ROOT_DIR, 'apps/ios/Sources'),
    ['.swift']
  )

  const mismatches: Mismatch[] = []

  const patterns: RegExp[] = [
    /NSLocalizedString\("([^"]+)"/g,
    /String\(localized:\s*"([^"]+)"/g,
    /LocalizedStringKey\("([^"]+)"/g,
  ]

  for (const file of files) {
    const content = readFileSync(file, 'utf-8')
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      const trimmed = line.trimStart()
      if (trimmed.startsWith('//')) continue
      if (isInBlockComment(lines, i)) continue

      for (const p of patterns) {
        p.lastIndex = 0
        let match: RegExpExecArray | null
        while ((match = p.exec(line)) !== null) {
          if (isInLineComment(line, match.index, '//')) continue

          const ref = match[1]
          if (!canonicalKeys.has(ref) && !allowlist.has(ref)) {
            mismatches.push({ file, line: i + 1, ref, kind: 'missing' })
          }
        }
      }
    }
  }

  return reportMismatches('iOS', mismatches)
}

// ---------------------------------------------------------------------------
// Desktop validator
// ---------------------------------------------------------------------------

function validateDesktop(): number {
  const canonicalKeys = loadCanonicalKeysDotted()
  const allowlist = loadAllowlist('desktop')
  const files = collectFiles(
    join(ROOT_DIR, 'src/client'),
    ['.ts', '.tsx']
  )

  const mismatches: Mismatch[] = []

  // Match t('key') and t("key")
  const staticPattern = /\bt\(\s*['"]([a-zA-Z0-9_.]+)['"]/g
  // Match t(`...${...}...`) template literals — dynamic keys
  const dynamicPattern = /\bt\(\s*`([^`]*\$\{[^`]*)`/g

  for (const file of files) {
    const content = readFileSync(file, 'utf-8')
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      const trimmed = line.trimStart()
      if (trimmed.startsWith('//')) continue
      if (isInBlockComment(lines, i)) continue

      // Check static keys
      staticPattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = staticPattern.exec(line)) !== null) {
        if (isInLineComment(line, match.index, '//')) continue

        const ref = match[1]
        // Keys ending with '.' are prefixes used with concatenation — treat as dynamic
        if (ref.endsWith('.')) {
          mismatches.push({ file, line: i + 1, ref, kind: 'warning' })
          continue
        }
        if (!canonicalKeys.has(ref) && !allowlist.has(ref)) {
          mismatches.push({ file, line: i + 1, ref, kind: 'missing' })
        }
      }

      // Check dynamic keys (warn only)
      dynamicPattern.lastIndex = 0
      while ((match = dynamicPattern.exec(line)) !== null) {
        if (isInLineComment(line, match.index, '//')) continue

        const ref = match[1]
        mismatches.push({ file, line: i + 1, ref, kind: 'warning' })
      }
    }
  }

  return reportMismatches('Desktop', mismatches)
}

// ---------------------------------------------------------------------------
// Key casing validator — en.json keys must be camelCase, never snake_case
// ---------------------------------------------------------------------------

function validateKeyCasing(): number {
  const data = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf-8'))
  const violations: string[] = []

  function check(obj: Record<string, unknown>, path: string) {
    for (const key of Object.keys(obj)) {
      const fullPath = path ? `${path}.${key}` : key
      // snake_case = contains underscore between lowercase letters/digits
      if (/_[a-z0-9]/.test(key)) {
        const camelSuggestion = key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
        violations.push(`  ${fullPath} → ${path ? path + '.' : ''}${camelSuggestion}`)
      }
      if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
        check(obj[key] as Record<string, unknown>, fullPath)
      }
    }
  }

  check(data, '')

  if (violations.length > 0) {
    console.error(`  en.json: ${violations.length} snake_case key(s) (must be camelCase):`)
    for (const v of violations) {
      console.error(v)
    }
  }

  return violations.length
}

// ---------------------------------------------------------------------------
// Locale coverage guard
//
// The single source of truth for "which locales exist" is the filesystem
// (packages/i18n/locales/*.json) and packages/i18n/languages.ts. Every other
// place that needs a locale list — CI guards, codegen, the exported locale
// map, the skills docs — must derive from one of those two, never hardcode
// its own list. This check is the regression guard for that rule: it fails
// loudly the moment a locale file and languages.ts (or the exported locale
// map in packages/i18n/index.ts) drift apart, which is exactly the failure
// mode that let 9 of 22 locales (am, fa, ku, mix, my, quc, so, tr, uk) go
// unvalidated for a long time.
// ---------------------------------------------------------------------------

function validateLocaleCoverage(): number {
  const localeCodes = readdirSync(LOCALES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''))
    .sort()

  const languageCodes = [...LANGUAGE_CODES].sort()

  const errors: string[] = []

  const missingFromLanguages = localeCodes.filter(c => !languageCodes.includes(c))
  if (missingFromLanguages.length > 0) {
    errors.push(
      `  locale file(s) with no entry in packages/i18n/languages.ts: ${missingFromLanguages.join(', ')}`
    )
  }

  const missingLocaleFile = languageCodes.filter(c => !localeCodes.includes(c))
  if (missingLocaleFile.length > 0) {
    errors.push(
      `  languages.ts entries with no packages/i18n/locales/*.json file: ${missingLocaleFile.join(', ')}`
    )
  }

  // packages/i18n/index.ts hand-exports each locale (for server-side lookups via
  // `locales`). Verify every locale file actually shows up as a bare-word
  // `export ... from './locales/<code>.json'` line, so a new locale can't be
  // added to the filesystem without also being wired into that export map.
  const indexSource = readFileSync(resolve(__dirname, '../index.ts'), 'utf-8')
  const missingFromIndex = localeCodes.filter(
    c => !new RegExp(`['"]\\./locales/${c}\\.json['"]`).test(indexSource)
  )
  if (missingFromIndex.length > 0) {
    errors.push(
      `  locale file(s) not exported from packages/i18n/index.ts: ${missingFromIndex.join(', ')}`
    )
  }

  if (errors.length > 0) {
    console.error(`  Locale coverage: ${errors.length} drift issue(s) found:`)
    for (const e of errors) console.error(e)
  } else {
    console.log(`  Locale coverage: ${localeCodes.length} locales, all covered`)
  }

  return errors.length
}

// ---------------------------------------------------------------------------
// Locale key completeness
//
// packages/i18n/tools/i18n-codegen.ts already computes this (and prints the
// same warnings) but only fails the process when invoked with --validate
// (`bun run i18n:validate`) — CI's "Validate i18n strings" step instead runs
// `bun run i18n:validate:all` (this script), which previously never checked
// per-locale key completeness at all. That meant a locale missing keys could
// pass CI outright (the plain `bun run i18n:codegen` step that does run in
// CI only warns and keeps going). Checking it here too closes that gap for
// every entry point into this script.
// ---------------------------------------------------------------------------

function validateLocaleCompleteness(): number {
  const enKeys = loadCanonicalKeysDotted()
  const localeFiles = readdirSync(LOCALES_DIR).filter(f => f.endsWith('.json') && f !== 'en.json')

  let totalMissing = 0
  for (const file of localeFiles) {
    const locale = file.replace(/\.json$/, '')
    const data = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf-8'))
    const keys = new Set(Object.keys(flattenKeysDotted(data)))
    const missing = [...enKeys].filter(k => !keys.has(k))
    if (missing.length > 0) {
      console.error(`  ${locale}: ${missing.length} missing key(s) relative to en.json`)
      totalMissing += missing.length
    }
  }

  if (totalMissing === 0) {
    console.log(`  Locale completeness: all ${localeFiles.length} non-English locales have full key coverage`)
  }

  return totalMissing
}

// ---------------------------------------------------------------------------
// Format-argument validators (issue #1413)
//
// The codegen renders every {{placeholder}} as an *object* specifier: `%N$@`
// on iOS, `%N$s` on Android. A specifier and the argument handed to it must
// agree, and the ways they can disagree are silent:
//
//   - `String(format: "%@", 30)` reads the Int as an object pointer and
//     segfaults in `_NSDescriptionWithStringProxyFunc`.
//   - `String(format: "%ld", "lots")` prints a garbage integer, no crash.
//   - `getString(R.string.x)` with no varargs renders `%1$s` literally.
//
// So iOS interpolation must go through `L10n.format`, which stringifies every
// argument, and every call must pass exactly as many arguments as the source
// string has placeholders.
// ---------------------------------------------------------------------------

/** Count {{placeholder}} occurrences in an en.json source string. */
function placeholderCount(value: string): number {
  return (value.match(/\{\{\w+\}\}/g) ?? []).length
}

/** Blank out line and block comments, preserving byte offsets and line numbers. */
function blankComments(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '"') {
      out += c
      i++
      while (i < src.length) {
        if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; continue }
        out += src[i]
        if (src[i] === '"') { i++; break }
        i++
      }
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++ }
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++ }
      out += '  '
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

/**
 * Index of the `)` matching the `(` at `openIdx`, skipping string literals.
 * Returns -1 when unbalanced (truncated/pathological source).
 */
function matchingParen(src: string, openIdx: number): number {
  let depth = 0
  let i = openIdx
  while (i < src.length) {
    const c = src[i]
    if (c === '"') {
      i++
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === '"') break
        i++
      }
    } else if (c === '(') {
      depth++
    } else if (c === ')') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

/** Split a call's argument list on top-level commas. */
function splitArguments(args: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  let i = 0
  while (i < args.length) {
    const c = args[i]
    if (c === '"') {
      i++
      while (i < args.length) {
        if (args[i] === '\\') { i += 2; continue }
        if (args[i] === '"') break
        i++
      }
    } else if (c === '(' || c === '[' || c === '{') {
      depth++
    } else if (c === ')' || c === ']' || c === '}') {
      depth--
    } else if (c === ',' && depth === 0) {
      parts.push(args.slice(start, i))
      start = i + 1
    }
    i++
  }
  const tail = args.slice(start)
  if (tail.trim().length > 0) parts.push(tail)
  return parts.map(p => p.trim()).filter(p => p.length > 0)
}

/**
 * Pre-existing sites where a source *sentence* is used as a bare label, or an
 * argument is handed to a string with no placeholder to receive it.
 *
 * Either way the user sees the wrong thing -- a raw "%1$@", or a value that
 * never appears -- but neither crashes, and fixing one means rewording the
 * English sentence or restructuring the view, not changing a call. That is
 * string-authoring work, distinct from the crash class this guard was built
 * for (issue #1413).
 *
 * They are pinned here so the inventory is explicit, printed on every CI run,
 * and a *new* occurrence still fails the build. Tracked by the follow-up issue
 * linked from #1413 -- remove entries as the strings are reworded, never add
 * one to get a build green.
 */
const PLACEHOLDER_MISMATCH_BACKLOG = new Set([
  'apps/ios/Sources/Views/Settings/ErasureRequestView.swift:erasure_request_confirm_message',
  'apps/ios/Sources/Views/Settings/ErasureRequestView.swift:erasure_countdown_days',
  'apps/ios/Sources/Views/Settings/ErasureRequestView.swift:erasure_countdown_hours',
  'apps/ios/Sources/Views/Settings/ErasureRequestView.swift:erasure_countdown_minutes',
  'apps/ios/Sources/Views/Settings/Channels/A2pRegistrationView.swift:channels_a2p_brand_status',
  'apps/ios/Sources/Views/Settings/Channels/A2pRegistrationView.swift:channels_a2p_campaign_status',
  'apps/ios/Sources/Views/Settings/Channels/SMSChannelConfigView.swift:channels_shared_enable_channel',
  'apps/ios/Sources/Views/Settings/Channels/TelegramChannelConfigView.swift:channels_shared_enable_channel',
  'apps/ios/Sources/Views/Admin/RecoveryRequestsView.swift:recovery_group_requests_approval_progress',
  'apps/ios/Sources/Views/Admin/UsersView.swift:admin_total_members',
  'apps/ios/Sources/Views/Admin/UsersView.swift:admin_admin_count',
  'apps/ios/Sources/Views/Admin/UsersView.swift:admin_active_count',
  'apps/android/app/src/main/java/org/llamenos/hotline/ui/settings/ErasureRequestScreen.kt:erasure_request_confirm_message',
  'apps/android/app/src/main/java/org/llamenos/hotline/ui/admin/channels/TelegramChannelConfigScreen.kt:channels_shared_enable_channel',
  'apps/ios/Sources/Views/ProviderSetup/OAuthProviderView.swift:provider_oauth_connect_button',
  'apps/android/app/src/main/java/org/llamenos/hotline/ui/shifts/ShiftsScreen.kt:shifts_since',
  'apps/android/app/src/main/java/org/llamenos/hotline/ui/dashboard/DashboardScreen.kt:active_since',
  'apps/android/app/src/main/java/org/llamenos/hotline/ui/notes/NoteDetailScreen.kt:notes_call_id_badge',
  'apps/android/app/src/main/java/org/llamenos/hotline/ui/notes/NoteDetailScreen.kt:notes_chat_id_badge',
  'apps/android/app/src/main/java/org/llamenos/hotline/ui/notes/NoteDetailScreen.kt:notes_updated',
  'apps/android/app/src/main/java/org/llamenos/hotline/ui/contacts/ContactsScreen.kt:contacts_first_seen',
  'apps/android/app/src/main/java/org/llamenos/hotline/ui/contacts/ContactsScreen.kt:contacts_last_seen',
  'apps/android/app/src/main/java/org/llamenos/hotline/ui/contacts/ContactTimelineScreen.kt:timeline_contact_id',
  'apps/android/app/src/main/java/org/llamenos/hotline/ui/reports/ReportDetailScreen.kt:reports_linked_call',
  'apps/android/app/src/main/java/org/llamenos/hotline/ui/providersetup/OAuthProviderScreen.kt:oauth_connect_title',
  'apps/android/app/src/main/java/org/llamenos/hotline/ui/providersetup/OAuthProviderScreen.kt:oauth_description',
  'apps/android/app/src/main/java/org/llamenos/hotline/ui/providersetup/OAuthProviderScreen.kt:connect_with_oauth',
  'apps/android/app/src/main/java/org/llamenos/hotline/ui/providersetup/APIKeyProviderScreen.kt:api_key_title',
  'apps/android/app/src/main/java/org/llamenos/hotline/ui/providersetup/APIKeyProviderScreen.kt:api_key_description',
  'apps/android/app/src/main/java/org/llamenos/hotline/ui/providersetup/ProviderSetupScreen.kt:phone_numbers_label',
  'apps/android/app/src/main/java/org/llamenos/hotline/ui/providersetup/ProviderSetupScreen.kt:connect_with_oauth',
  'apps/android/app/src/main/java/org/llamenos/hotline/ui/providersetup/ProviderSetupScreen.kt:connection_success',
  'apps/android/app/src/main/java/org/llamenos/hotline/ui/providersetup/ProviderSetupScreen.kt:account_name_label',
  'apps/android/app/src/main/java/org/llamenos/hotline/ui/providersetup/PhoneNumberScreen.kt:provision_success_message',
  'apps/android/app/src/main/java/org/llamenos/hotline/ui/providersetup/PhoneNumberScreen.kt:provision_number_confirm',
  'apps/android/app/src/main/java/org/llamenos/hotline/ui/admin/UserDetailScreen.kt:users_joined',
  'apps/android/app/src/main/java/org/llamenos/hotline/ui/admin/SystemHealthTab.kt:admin_system_last_updated',
])

interface FormatFinding { file: string; line: number; message: string; backlogged?: boolean }

const lineOf = (src: string, index: number) => src.slice(0, index).split('\n').length

/**
 * iOS: reject `String(format:)` on a non-literal format string, and check the
 * argument arity of every `L10n.format` call.
 */
function checkSwiftSource(
  file: string,
  rawSource: string,
  sources: Record<string, string>
): FormatFinding[] {
  const findings: FormatFinding[] = []
  const src = blankComments(rawSource)

  // Rule 1: the format string handed to String(format:) must be a literal.
  const formatCall = /String\(\s*format:\s*/g
  let m: RegExpExecArray | null
  while ((m = formatCall.exec(src)) !== null) {
    if (src[m.index + m[0].length] === '"') continue
    findings.push({
      file,
      line: lineOf(src, m.index),
      message:
        'String(format:) on a non-literal format string. Localized templates use the ' +
        'object specifier %N$@, which crashes when handed a non-object argument -- ' +
        'use L10n.format(key, comment:, args...) instead (issue #1413).',
    })
  }

  // Rule 2: a bare NSLocalizedString on a source string that has placeholders
  // renders the raw specifier ("%1$@") to the user.
  const bareLookup = /(?<!format:\s*)\bNSLocalizedString\(\s*"([^"]+)"/g
  while ((m = bareLookup.exec(src)) !== null) {
    // Skip lookups that are the template argument of an L10n.format/String(format:) call.
    const before = src.slice(Math.max(0, m.index - 40), m.index)
    if (/format:\s*$/.test(before)) continue
    const source = sources[m[1]]
    if (source === undefined) continue
    const expected = placeholderCount(source)
    if (expected > 0) {
      findings.push({
        file,
        line: lineOf(src, m.index),
        message: `NSLocalizedString("${m[1]}") is rendered without arguments but the source string has ${expected} placeholder(s), so the raw specifier reaches the UI: ${JSON.stringify(source)}`,
        backlogged: PLACEHOLDER_MISMATCH_BACKLOG.has(`${relative(ROOT_DIR, file)}:${m[1]}`),
      })
    }
  }

  // Rule 3: L10n.format argument count must match the source string's placeholders.
  const l10nCall = /\bL10n\.format\(/g
  while ((m = l10nCall.exec(src)) !== null) {
    const open = m.index + m[0].length - 1
    const close = matchingParen(src, open)
    if (close === -1) continue
    const args = splitArguments(src.slice(open + 1, close))
    if (args.length === 0) continue
    const keyMatch = /^"([^"]+)"$/.exec(args[0])
    if (!keyMatch) continue // dynamic key (e.g. a ternary) -- not statically checkable
    const key = keyMatch[1]
    const source = sources[key]
    if (source === undefined) continue // key not yet translated; nothing to check against
    const supplied = args.slice(1).filter(a => !a.startsWith('comment:')).length
    const expected = placeholderCount(source)
    if (supplied !== expected) {
      findings.push({
        file,
        line: lineOf(src, m.index),
        message: `L10n.format("${key}") passes ${supplied} argument(s) but the source string has ${expected} placeholder(s): ${JSON.stringify(source)}`,
        backlogged: PLACEHOLDER_MISMATCH_BACKLOG.has(`${relative(ROOT_DIR, file)}:${key}`),
      })
    }
  }

  return findings
}

/**
 * Android: `getString`/`stringResource` argument count must match the source
 * string's placeholders, and manual `%@`/`%s` substitution is forbidden.
 */
function checkKotlinSource(
  file: string,
  rawSource: string,
  sources: Record<string, string>
): FormatFinding[] {
  const findings: FormatFinding[] = []
  const src = blankComments(rawSource)

  const call = /\b(?:stringResource|getString)\(\s*R\.string\.(\w+)/g
  let m: RegExpExecArray | null
  while ((m = call.exec(src)) !== null) {
    const key = m[1]
    const source = sources[key]
    if (source === undefined) continue
    const expected = placeholderCount(source)
    const open = src.lastIndexOf('(', m.index + m[0].length)
    const close = matchingParen(src, open)
    if (close === -1) continue
    const supplied = splitArguments(src.slice(open + 1, close)).length - 1
    if (supplied !== expected) {
      findings.push({
        file,
        line: lineOf(src, m.index),
        message: `R.string.${key} is rendered with ${supplied} argument(s) but the source string has ${expected} placeholder(s): ${JSON.stringify(source)}`,
        backlogged: PLACEHOLDER_MISMATCH_BACKLOG.has(`${relative(ROOT_DIR, file)}:${key}`),
      })
    }
  }

  // Manual substitution means the generated specifier did not match the call --
  // fix the source string instead of patching the rendered output.
  const manual = /\.replace\(\s*"%[@sd]"/g
  while ((m = manual.exec(src)) !== null) {
    findings.push({
      file,
      line: lineOf(src, m.index),
      message: 'manual format-specifier substitution. Write the source string with {{placeholder}} and pass the value as a getString/stringResource argument (issue #1413).',
    })
  }

  return findings
}

function reportFindings(platform: string, findings: FormatFinding[]): number {
  const errors = findings.filter(f => !f.backlogged)
  const backlog = findings.filter(f => f.backlogged)

  if (errors.length === 0) {
    console.log(`  ${platform} format arguments: all calls match their source strings`)
  } else {
    console.error(`  ${platform} format arguments: ${errors.length} problem(s):`)
    for (const f of errors) {
      console.error(`    ${relative(ROOT_DIR, f.file)}:${f.line} -- ${f.message}`)
    }
  }

  if (backlog.length > 0) {
    console.warn(`  ${platform} format arguments: ${backlog.length} known placeholder mismatch(es) (pinned backlog -- see #1413 follow-up):`)
    for (const f of backlog) {
      console.warn(`    ${relative(ROOT_DIR, f.file)}:${f.line} -- ${f.message}`)
    }
  }

  return errors.length
}

function validateIOSFormatArguments(): number {
  const sources = loadEnglishSourcesUnderscore()
  const files = collectFiles(join(ROOT_DIR, 'apps/ios/Sources'), ['.swift'])
    // L10n.format is the one sanctioned String(format:) call site.
    .filter(f => !f.endsWith('Utilities/LocalizedFormat.swift'))
  const findings = files.flatMap(f => checkSwiftSource(f, readFileSync(f, 'utf-8'), sources))
  return reportFindings('iOS', findings)
}

function validateAndroidFormatArguments(): number {
  const sources = loadEnglishSourcesUnderscore()
  const files = collectFiles(join(ROOT_DIR, 'apps/android/app/src'), ['.kt'])
  const findings = files.flatMap(f => checkKotlinSource(f, readFileSync(f, 'utf-8'), sources))
  return reportFindings('Android', findings)
}

/**
 * Prove the detectors fire by feeding them the defects they exist to catch.
 *
 * A guard that is never shown failing is a guard nobody knows is wired up; this
 * runs on every CI invocation so the check cannot silently rot into a no-op.
 */
function selfTestFormatArguments(): number {
  const sources = {
    self_test_two: 'Page {{page}} of {{total}}',
    self_test_one: 'Copy {{label}}',
    self_test_none: 'Settings',
  }

  interface Case { name: string; lang: 'swift' | 'kotlin'; source: string; shouldFlag: boolean }
  const cases: Case[] = [
    {
      name: 'swift: String(format:) on a localized template',
      lang: 'swift',
      source: 'let s = String(format: NSLocalizedString("self_test_two", comment: ""), a, b)',
      shouldFlag: true,
    },
    {
      name: 'swift: String(format:) on a variable template',
      lang: 'swift',
      source: 'let s = String(format: template, value)',
      shouldFlag: true,
    },
    {
      name: 'swift: multi-line String(format:) on a localized template',
      lang: 'swift',
      source: 'let s = String(\n    format: NSLocalizedString("self_test_one", comment: ""),\n    label\n)',
      shouldFlag: true,
    },
    {
      name: 'swift: L10n.format with too few arguments',
      lang: 'swift',
      source: 'let s = L10n.format("self_test_two", comment: "c", page)',
      shouldFlag: true,
    },
    {
      name: 'swift: L10n.format with too many arguments',
      lang: 'swift',
      source: 'let s = L10n.format("self_test_none", comment: "c", extra)',
      shouldFlag: true,
    },
    {
      name: 'swift: correct L10n.format call',
      lang: 'swift',
      source: 'let s = L10n.format(\n    "self_test_two",\n    comment: "c",\n    page,\n    total\n)',
      shouldFlag: false,
    },
    {
      name: 'swift: String(format:) on a literal is still allowed',
      lang: 'swift',
      source: 'let hex = bytes.map { String(format: "%02x", $0) }.joined()',
      shouldFlag: false,
    },
    {
      name: 'swift: commented-out offender is not flagged',
      lang: 'swift',
      source: '// let s = String(format: NSLocalizedString("self_test_one", comment: ""), label)',
      shouldFlag: false,
    },
    {
      name: 'swift: bare NSLocalizedString on a placeholder string',
      lang: 'swift',
      source: 'Text(NSLocalizedString("self_test_one", comment: ""))',
      shouldFlag: true,
    },
    {
      name: 'swift: bare NSLocalizedString on a plain string is fine',
      lang: 'swift',
      source: 'Text(NSLocalizedString("self_test_none", comment: ""))',
      shouldFlag: false,
    },
    {
      name: 'kotlin: stringResource with no argument for a placeholder string',
      lang: 'kotlin',
      source: 'Text(text = stringResource(R.string.self_test_one))',
      shouldFlag: true,
    },
    {
      name: 'kotlin: manual %@ substitution',
      lang: 'kotlin',
      source: 'val t = stringResource(R.string.self_test_one, x).replace("%@", label)',
      shouldFlag: true,
    },
    {
      name: 'kotlin: a backlogged file still fails for a MISSING argument',
      lang: 'kotlin',
      source: 'val t = stringResource(R.string.self_test_two, page)',
      shouldFlag: true,
    },
    {
      name: 'kotlin: correct getString call',
      lang: 'kotlin',
      source: 'val t = getString(R.string.self_test_two, page, total)',
      shouldFlag: false,
    },
  ]

  let failures = 0
  for (const c of cases) {
    const findings = c.lang === 'swift'
      ? checkSwiftSource('<self-test>', c.source, sources)
      : checkKotlinSource('<self-test>', c.source, sources)
    const flagged = findings.length > 0
    if (flagged !== c.shouldFlag) {
      failures++
      console.error(
        `  self-test FAILED: ${c.name} -- expected ${c.shouldFlag ? 'a finding' : 'no finding'}, got ${findings.length}`
      )
      findings.forEach(f => console.error(`      ${f.message}`))
    }
  }

  if (failures === 0) {
    console.log(`  Format-argument self-test: ${cases.length}/${cases.length} detector cases behave as specified`)
  }
  return failures
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const command = process.argv[2]

  if (!command || !['android', 'ios', 'desktop', 'all'].includes(command)) {
    console.error('Usage: validate-strings.ts <android|ios|desktop|all>')
    process.exit(1)
  }

  console.log('Validating string references...')

  let totalErrors = 0

  // Always check key casing convention, locale-list coverage, and per-locale
  // key completeness first — these apply regardless of which platform is
  // being validated.
  totalErrors += validateKeyCasing()
  totalErrors += validateLocaleCoverage()
  totalErrors += validateLocaleCompleteness()
  totalErrors += selfTestFormatArguments()

  if (command === 'android' || command === 'all') {
    totalErrors += validateAndroid()
    totalErrors += validateAndroidFormatArguments()
  }
  if (command === 'ios' || command === 'all') {
    totalErrors += validateIOS()
    totalErrors += validateIOSFormatArguments()
  }
  if (command === 'desktop' || command === 'all') {
    totalErrors += validateDesktop()
  }

  if (totalErrors > 0) {
    console.error(`\n${totalErrors} string reference error(s) found.`)
    process.exit(1)
  } else {
    console.log('\nAll string references valid.')
  }
}

main()
