/**
 * Centralized language configuration for Llámenos.
 * Used by both frontend (i18n, UI) and backend (telephony, voice prompts).
 *
 * This file (LANGUAGE_CODES below) is, together with the locale JSON files in
 * packages/i18n/locales/, the source of truth for "which locales exist."
 * NEVER hardcode a separate locale list or count anywhere else — derive it
 * from here or from `readdirSync(packages/i18n/locales)` instead, the way
 * packages/i18n/tools/i18n-codegen.ts does. A hardcoded list drifts the
 * moment a locale is added without updating every copy of it — that is how
 * this file itself ended up missing 'de' for a period, and how CI silently
 * stopped validating 9 of 22 locales. See
 * packages/i18n/tools/validate-strings.ts's validateLocaleCoverage() for the
 * automated guard against this drifting again.
 *
 * To add a new language:
 * 1. Add entry here with all fields
 * 2. Create packages/i18n/locales/{code}.json with all translation keys (including voice.* and ivr.*)
 * 3. Run `bun run i18n:validate:all` — it will fail loudly if the new locale
 *    isn't fully wired in (languages.ts entry, packages/i18n/index.ts export,
 *    complete key coverage).
 */

export interface LanguageConfig {
  /** ISO 639-1 code (e.g. 'en', 'es', 'fr') */
  code: string
  /** Native language name (e.g. 'Español', 'Français') */
  label: string
  /** Short display code for UI buttons (e.g. 'EN', 'ES') */
  flag: string
  /** Phone number prefixes for auto-detection (E.164 format) */
  phonePrefixes: string[]
}

export const LANGUAGES: LanguageConfig[] = [
  // --- Base ---
  {
    code: 'en',
    label: 'English',
    flag: 'EN',
    phonePrefixes: ['+1', '+44', '+61', '+64'], // US/Canada, UK, Australia, NZ
  },
  // --- Top 10 US immigrant languages ---
  {
    code: 'es',
    label: 'Español',
    flag: 'ES',
    phonePrefixes: [
      '+52',  '+34',  '+54',  '+56',  '+57',  '+58',  '+51',  '+53',
      '+591', '+593', '+595', '+598', '+502', '+503', '+504', '+505',
      '+506', '+507', '+809', '+829', '+849',
    ],
  },
  {
    code: 'zh',
    label: '中文',
    flag: '中',
    phonePrefixes: [
      '+86',  // China
      '+886', // Taiwan
      '+852', // Hong Kong
      '+853', // Macau
    ],
  },
  {
    code: 'tl',
    label: 'Tagalog',
    flag: 'TL',
    phonePrefixes: ['+63'], // Philippines
  },
  {
    code: 'vi',
    label: 'Tiếng Việt',
    flag: 'VI',
    phonePrefixes: ['+84'], // Vietnam
  },
  {
    code: 'ar',
    label: 'العربية',
    flag: 'ع',
    phonePrefixes: [
      '+20',  // Egypt
      '+212', // Morocco
      '+213', // Algeria
      '+216', // Tunisia
      '+218', // Libya
      '+249', // Sudan
      '+961', // Lebanon
      '+962', // Jordan
      '+963', // Syria
      '+964', // Iraq
      '+966', // Saudi Arabia
      '+967', // Yemen
      '+968', // Oman
      '+970', // Palestine
      '+971', // UAE
      '+973', // Bahrain
      '+974', // Qatar
    ],
  },
  {
    code: 'fr',
    label: 'Français',
    flag: 'FR',
    phonePrefixes: [
      '+33',  // France
      '+32',  // Belgium
      '+225', // Côte d'Ivoire
      '+221', // Senegal
      '+243', // DR Congo
      '+237', // Cameroon
    ],
  },
  {
    code: 'ht',
    label: 'Kreyòl Ayisyen',
    flag: 'HT',
    phonePrefixes: ['+509'], // Haiti
  },
  {
    code: 'ko',
    label: '한국어',
    flag: '한',
    phonePrefixes: ['+82'], // South Korea
  },
  {
    code: 'ru',
    label: 'Русский',
    flag: 'RU',
    phonePrefixes: [
      '+7',   // Russia & Kazakhstan
      '+375', // Belarus
    ],
  },
  {
    code: 'hi',
    label: 'हिन्दी',
    flag: 'हि',
    phonePrefixes: ['+91'], // India
  },
  // --- Additional ---
  {
    code: 'pt',
    label: 'Português',
    flag: 'PT',
    phonePrefixes: [
      '+55',  // Brazil
      '+351', // Portugal
      '+244', // Angola
      '+258', // Mozambique
    ],
  },
  {
    code: 'de',
    label: 'Deutsch',
    flag: 'DE',
    phonePrefixes: [
      '+49', // Germany
      '+43', // Austria
      '+41', // Switzerland
    ],
  },
  // --- At-risk & diaspora communities ---
  {
    code: 'uk',
    label: 'Українська',
    flag: 'УК',
    phonePrefixes: ['+380'], // Ukraine
  },
  {
    code: 'fa',
    label: 'فارسی',
    flag: 'فا',
    phonePrefixes: [
      '+98', // Iran
      '+93', // Afghanistan (Dari)
    ],
  },
  {
    code: 'tr',
    label: 'Türkçe',
    flag: 'TR',
    phonePrefixes: ['+90'], // Turkey
  },
  {
    code: 'ku',
    label: 'Kurdî',
    flag: 'KU',
    phonePrefixes: [], // Stateless — no country prefix; detected via UI selection
  },
  {
    code: 'so',
    label: 'Soomaali',
    flag: 'SO',
    phonePrefixes: ['+252'], // Somalia
  },
  {
    code: 'am',
    label: 'አማርኛ',
    flag: 'አማ',
    phonePrefixes: ['+251'], // Ethiopia
  },
  {
    code: 'my',
    label: 'မြန်မာ',
    flag: 'MY',
    phonePrefixes: ['+95'], // Myanmar
  },
  {
    code: 'quc',
    label: "K'iche'",
    flag: 'KI',
    phonePrefixes: [], // Indigenous — no country prefix; detected via UI selection
  },
  {
    code: 'mix',
    label: "Tu'un savi",
    flag: 'MX',
    phonePrefixes: [], // Indigenous — no country prefix; detected via UI selection
  },
]

/** Map of code -> config for quick lookup */
export const LANGUAGE_MAP = Object.fromEntries(LANGUAGES.map(l => [l.code, l])) as Record<string, LanguageConfig>

/** All supported language codes */
export const LANGUAGE_CODES = LANGUAGES.map(l => l.code)

/** Default / fallback language */
export const DEFAULT_LANGUAGE = 'en'

/**
 * IVR language menu — default ordered list of languages for phone keypad selection.
 * This is the system-wide default, overridden by per-hub config in hub_settings.settings.ivrLanguages.
 * Digit assignment: index 0 → '1', index 1 → '2', ..., index 8 → '9', index 9 → '0'.
 * Languages not in this list rely on phone-prefix auto-detection.
 */
export const IVR_LANGUAGES: string[] = [
  'es', 'en', 'zh', 'tl', 'vi', 'ar', 'fr', 'ht', 'ko', 'ru',
]

/**
 * The keypad has ten digits (1-9 then 0), so an IVR language menu holds at most
 * ten languages. Every other language is reached by phone-prefix detection.
 */
export const IVR_MENU_MAX_LANGUAGES = 10

/** Convert IVR array index to phone digit string */
export function ivrIndexToDigit(index: number): string {
  if (index >= 0 && index <= 8) return String(index + 1)
  if (index === 9) return '0'
  return ''
}

/** Look up language code from a caller's digit press. Returns undefined for invalid digits. */
export function languageFromDigit(digit: string, languages?: string[]): string | undefined {
  const list = languages ?? IVR_LANGUAGES
  const index = digit === '0' ? 9 : parseInt(digit, 10) - 1
  if (index >= 0 && index < list.length) return list[index]
  return undefined
}

/**
 * Detect caller language from phone number country code.
 * Longer prefixes are matched first for specificity.
 * Falls back to 'en' if no match.
 */
export function detectLanguageFromPhone(phone: string): string {
  // Build a flat list of [prefix, langCode] sorted by prefix length desc
  const prefixMap: Array<[string, string]> = []
  for (const lang of LANGUAGES) {
    for (const prefix of lang.phonePrefixes) {
      prefixMap.push([prefix, lang.code])
    }
  }
  prefixMap.sort((a, b) => b[0].length - a[0].length)

  for (const [prefix, code] of prefixMap) {
    if (phone.startsWith(prefix)) return code
  }
  return DEFAULT_LANGUAGE
}
