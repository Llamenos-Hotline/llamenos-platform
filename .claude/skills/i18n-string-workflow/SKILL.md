---
name: i18n-string-workflow
description: >
  Manage internationalization strings across all locales in packages/i18n/locales/ (see
  packages/i18n/languages.ts for the current, authoritative list — never hardcode a count) and
  3 platforms (desktop, iOS, Android)
  in the Llamenos monorepo. Use this skill whenever adding, renaming, moving, or removing i18n
  strings, when the user mentions "i18n", "localization", "translation", "locale", "strings",
  "add a string", "new language", "all languages", "translate", "multilingual", or when modifying
  any file in packages/i18n/. Also use when the user says something needs to work "in all
  languages", asks to "add support for [language name]" (e.g., "add Swahili", "add Japanese"),
  or mentions string keys like t('key') or R.string.key. Use when running codegen or validation
  for i18n, fixing missing string references, or when any feature work implicitly requires new
  user-facing text. This skill prevents the most common i18n bugs: missing locale propagation,
  wrong key casing, stale codegen output, and broken platform references.
---

# i18n String Workflow for Llamenos

The i18n system spans every locale in `packages/i18n/locales/` (source of truth:
`packages/i18n/languages.ts` — do not hardcode a locale count or list anywhere else, it will
drift), 3 platforms, and thousands of keys. Every string change requires
a specific sequence of steps — skipping any step causes runtime crashes or empty strings on
at least one platform.

## Architecture

```
en.json (source of truth, camelCase nested objects)
  ↓ propagate
*.json (every file in packages/i18n/locales/ except en.json — same structure, translated values)
  ↓ bun run i18n:codegen
  ├── iOS: apps/ios/Resources/Localizable/{locale}.lproj/Localizable.strings
  ├── Android: apps/android/app/src/main/res/values-{locale}/strings.xml
  ├── Android: apps/android/.../i18n/I18n.kt (compile-time constants)
  └── generated/: Reference copies
  ↓ bun run i18n:validate:all
  ├── Desktop: t('dotted.camelCase.key') calls match en.json paths
  ├── iOS: NSLocalizedString("snake_case_key") calls match .strings output
  └── Android: R.string.snake_case_key refs match strings.xml output
```

### Key Convention

| Layer | Format | Example |
|-------|--------|---------|
| **en.json** (source) | Nested camelCase | `{ "dashboard": { "activeCalls": "Active Calls" } }` |
| **Desktop t()** | Dot-separated camelCase | `t('dashboard.activeCalls')` |
| **iOS .strings** | Flat snake_case | `"dashboard_active_calls" = "Active Calls";` |
| **Android strings.xml** | Flat snake_case | `<string name="dashboard_active_calls">Active Calls</string>` |
| **Android Kotlin** | R.string constant | `R.string.dashboard_active_calls` |

The codegen automatically converts `camelCase → snake_case` during flattening. You NEVER put
snake_case keys in en.json.

## Workflows

### Adding a New String

1. **Add to en.json** in the correct nested section using camelCase:
   ```json
   {
     "dashboard": {
       "activeCalls": "Active Calls",
       "newFeatureLabel": "My New Feature"  // <-- add here
     }
   }
   ```

2. **Propagate to all locale files** — add the same key to every locale JSON:
   - Provide a real translation in every locale. A new or changed value that is verbatim English fails
     `bun run i18n:untranslated` (CI) even if it is recorded in `deferred.json`. If the English text is
     genuinely correct in a locale (brand name, protocol term), list the key in that locale's top-level
     `_same_as_en` array instead
   - Maintain the same nested position in every file
   - Every locale MUST have the key (`bun run i18n:validate` fails loudly on missing keys)

   ```bash
   # Files to update — every locale file except en.json. Get the current list with:
   ls packages/i18n/locales/*.json | grep -v /en.json
   ```

3. **Run codegen**:
   ```bash
   bun run i18n:codegen
   ```
   This regenerates iOS .strings, Android strings.xml, and Kotlin I18n.kt.

4. **Reference the string in platform code**:
   - **Desktop**: `t('dashboard.newFeatureLabel')`
   - **iOS**: `NSLocalizedString("dashboard_new_feature_label", comment: "")`
   - **Android**: `stringResource(R.string.dashboard_new_feature_label)` or `I18n.DASHBOARD_NEW_FEATURE_LABEL`

5. **Validate**:
   ```bash
   bun run i18n:validate:all
   ```
   This checks all platform references against codegen output. Zero errors = safe to commit.

### Renaming/Moving a String

1. **Update en.json**: Change the key name or move to a different section
2. **Propagate**: Make the identical change in every other locale file (all files in
   `packages/i18n/locales/` except `en.json`)
3. **Run codegen**: `bun run i18n:codegen`
4. **Update platform references**:
   - **Desktop**: Find all `t('old.key')` → `t('new.key')` in `src/client/**/*.{ts,tsx}`
   - **iOS**: Find all `NSLocalizedString("old_key"` → `NSLocalizedString("new_key"` in `apps/ios/Sources/**/*.swift`
   - **Android**: Find all `R.string.old_key` → `R.string.new_key` in `apps/android/**/*.kt`
5. **Validate**: `bun run i18n:validate:all`

### Removing a String

1. **Remove from en.json**
2. **Remove from every other locale file** (all files in `packages/i18n/locales/` except `en.json`)
3. **Run codegen**: `bun run i18n:codegen`
4. **Remove all platform references** (desktop t() calls, iOS NSLocalizedString, Android R.string)
5. **Validate**: `bun run i18n:validate:all`

### Adding Strings for Multiple Sections at Once

When implementing a feature that needs many strings:

1. **Plan all keys first** — list them in the epic before touching code
2. **Batch-add to en.json** in one edit
3. **Batch-propagate** to all locales in one pass
4. **Run codegen once** after all strings are added
5. **Implement platform code** referencing the new keys
6. **Validate once** at the end

This is more efficient than add-one-validate-one loops.

## Adding a New Language

When adding support for a new locale (e.g., `ja` for Japanese):

### 1. Create the locale file

```bash
# Copy en.json as the starting point
cp packages/i18n/locales/en.json packages/i18n/locales/ja.json
```

Edit `ja.json` to translate all values (keep all keys identical to en.json).

### 2. Update language configuration

Edit `packages/i18n/languages.ts`:

```typescript
// Add to LANGUAGES array:
{
  code: 'ja',
  label: '日本語',
  flag: '日',
  phonePrefixes: ['+81'], // Japan
},
```

### 3. Add locale mapping for platforms (if needed)

Check if the locale code needs mapping in `packages/i18n/tools/i18n-codegen.ts`:

```typescript
// Only needed if the ISO code differs from platform convention
const IOS_LOCALE_MAP: Record<string, string> = {
  zh: 'zh-Hans',
  pt: 'pt-BR',
  // ja: 'ja',  // Standard — no mapping needed
}

const ANDROID_LOCALE_MAP: Record<string, string> = {
  zh: 'zh-rCN',
  pt: 'pt-rBR',
  // ja: 'ja',  // Standard — no mapping needed
}
```

Most locales don't need mapping — only add entries when the platform convention differs from
the ISO 639-1 code (e.g., Chinese simplified, Brazilian Portuguese).

### 4. Register in desktop i18n

Edit `src/client/lib/i18n.ts`:
- Import the new locale JSON
- Add it to the i18next resources configuration

### 5. Run codegen and validate

```bash
bun run i18n:codegen        # Generates new .lproj and values- directories
bun run i18n:validate:all   # Validates all platform references
```

### 6. Create iOS locale directory

Codegen creates the `.strings` file, but Xcode needs the `.lproj` directory registered.
Verify `apps/ios/Resources/Localizable/ja.lproj/Localizable.strings` was created by codegen.

### 7. Create Android resource directory

Codegen creates `apps/android/app/src/main/res/values-ja/strings.xml` automatically.

### 8. Update IVR (if applicable)

If the language should be available in the phone IVR menu, update `IVR_LANGUAGES` in
`packages/i18n/languages.ts`. The array is limited to 10 entries (phone keypad digits 1-9, 0).

### 9. Test

- Desktop: Switch language in settings, verify UI strings render
- iOS: Build and verify new `.lproj` is bundled
- Android: Build and verify new `values-` directory is included
- Run `bun run i18n:validate:all` — should report the new locale in coverage

## Platform-Specific Details

### Desktop (i18next)

- Strings accessed via `t('dotted.path')` matching en.json nesting
- i18next handles interpolation: `{{variable}}` in JSON → runtime substitution
- Language switching in `src/client/lib/i18n.ts`

### iOS

- Codegen outputs `Localizable.strings` per locale in `.lproj` directories
- Interpolation: `{{name}}` in JSON → `%@` in .strings (ordered by occurrence)
- Special characters escaped: `"`, `\`, newlines
- Access via `NSLocalizedString("key", comment: "")` or `String(localized:)`

### Android

- Codegen outputs `strings.xml` per locale in `values-{code}` directories
- Also generates `I18n.kt` with compile-time `R.string.*` constant references and English text comments
- Interpolation: `{{name}}` in JSON → `%1$s` in XML (numbered by occurrence)
- XML special characters escaped: `<`, `>`, `&`, `'`, `"`
- Access via `stringResource(R.string.key)` in Compose or `getString(R.string.key)` in Kotlin

### Codegen Internals

Located at `packages/i18n/tools/i18n-codegen.ts`:
- `flattenKeysSnake()` — flattens nested JSON and converts camelCase → snake_case
- `toIOSString()` — converts i18next `{{var}}` to iOS `%@` format
- `toAndroidString()` — converts i18next `{{var}}` to Android `%1$s` format
- `escapeAndroidString()` — escapes XML special characters
- Platform locale maps for non-standard codes (zh→zh-Hans, pt→pt-BR)

### Validator Internals

Located at `packages/i18n/tools/validate-strings.ts`:
- **Android**: Scans `R.string.*` refs in `apps/android/**/*.kt`, compares against codegen keys
- **iOS**: Scans `NSLocalizedString`/`String(localized:)` in `apps/ios/Sources/**/*.swift`
- **Desktop**: Scans `t('key')` calls in `src/client/**/*.{ts,tsx}`, warns on dynamic keys
- Allowlist: `packages/i18n/tools/validate-allowlist.json` for non-i18n R.string resources

## Common Mistakes

| Mistake | Consequence | Prevention |
|---------|-------------|------------|
| snake_case key in en.json | Mobile gets double-snake (`some__key`) | Always use camelCase in source |
| Forgot to propagate to a locale | Codegen warns, runtime shows key name | Check every locale file in every edit (`bun run i18n:validate`) |
| Forgot `bun run i18n:codegen` | Platform still has old strings | Always codegen after JSON changes |
| Forgot `bun run i18n:validate:all` | Broken ref discovered in production | Always validate before committing |
| Used `R.string.shift_clock_in` (singular) | Should be `R.string.shifts_clock_in` (from section name) | Codegen flattens section name, not singular |
| Added string only to en.json | Other locales missing the key | Propagate immediately |
| Hardcoded string in platform code | Not localizable | Always use i18n system |

## Quick Reference Commands

```bash
bun run i18n:codegen              # Generate all platform strings
bun run i18n:validate             # Check locale completeness
bun run i18n:validate:android     # Validate R.string.* refs
bun run i18n:validate:ios         # Validate NSLocalizedString refs
bun run i18n:validate:desktop     # Validate t('key') refs
bun run i18n:validate:all         # Run all three validators
```

## File Locations

| File | Purpose |
|------|---------|
| `packages/i18n/locales/en.json` | Source of truth |
| `packages/i18n/locales/*.json` | All locale files (count: see `packages/i18n/languages.ts`, never hardcode it) |
| `packages/i18n/languages.ts` | Language config (codes, labels, phone prefixes) |
| `packages/i18n/tools/i18n-codegen.ts` | Codegen: JSON → .strings + strings.xml + I18n.kt |
| `packages/i18n/tools/validate-strings.ts` | Cross-platform string ref validator |
| `packages/i18n/tools/validate-allowlist.json` | Allowlist for non-i18n R.string resources |
| `apps/ios/Resources/Localizable/` | Generated iOS .strings per locale |
| `apps/android/app/src/main/res/values-*/` | Generated Android strings.xml per locale |
| `apps/android/.../i18n/I18n.kt` | Generated Kotlin constants |
| `src/client/lib/i18n.ts` | Desktop i18next setup + locale registration |
