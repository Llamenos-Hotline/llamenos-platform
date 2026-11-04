# packages/i18n

Localization package for Llamenos. Manages translations across all locales in `locales/` (source of truth: `languages.ts` — never hardcode a locale count elsewhere) and generates platform-specific string files.

## Supported Locales

`en`, `es`, `zh`, `tl`, `vi`, `ar`, `fr`, `ht`, `ko`, `ru`, `hi`, `pt`, `de`

`en` is the reference locale. All other locales are complete translations.

## The three-state completeness gate

`bun run i18n:validate` (and `bun run i18n:validate:all`, the CI gate) classifies
every key × locale pair into exactly one of three states:

| State | Meaning | Gate |
|---|---|---|
| **missing** | key absent from the locale file | hard fail |
| **deferred** | value is verbatim English AND the pair is listed in `deferred.json` | pass, counted |
| **translated** | value differs from English, not listed | pass, counted |

Two failure modes make the record self-maintaining:

- **Unrecorded English copy** — a value identical to en with no `deferred.json`
  entry fails the gate. A locale file that merely *happens* to equal en is NOT
  deferred; the record must say so. This is the regression case a
  presence-only gate cannot see.
- **Stale deferral** — a translated value whose `deferred.json` entry was left
  behind also fails, so the record cannot rot. A translator's complete job is:
  supply the text, remove the entry.

`deferred.json` is keyed by locale → sorted list of dotted en.json paths
(e.g. `admin.activeInvitesHeader`). It is diffable and reviewable; every entry
asserts "this locale knowingly carries English here". Record entries pointing
at keys en.json no longer has, or at keys missing from the locale file, fail
the gate as record rot.

Maintenance command:

```bash
bun run i18n:codegen --sync-deferral
```

rewrites `deferred.json` so each locale's entry set is exactly its
verbatim-English keys. Run it after *intentionally* copying English text into
a locale (e.g. scaffolding a new locale) — never to silence a failure you have
not reviewed; the whole point of the record is that deferral is a deliberate,
visible act.

## The untranslated-value gate (new and changed strings)

The deferral record is a self-service allowlist: recording a new English copy in
`deferred.json` makes the three-state gate pass. So a second gate, which never
reads `deferred.json`, stops the backlog widening (#2335):

```bash
bun run i18n:untranslated                    # vs merge-base(HEAD, origin/main)
bun run i18n:untranslated -- --base <ref>
```

- **Blocking** — a (key, locale) pair that this change adds or alters (new key,
  changed English text, new or changed locale value) whose value is verbatim
  English. Recording it in `deferred.json` does not excuse it.
- **Reported, not blocking** — the whole backlog, per locale, plus the
  caller-facing `voice.*` / `ivr.*` subset. Written to the CI job summary on
  every run.
- The baseline is read from git at the merge base. There is no snapshot file,
  and the gate exits 2 rather than pass when no merge base can be resolved.
- A brand-new locale has no baseline: it is reported, not blocked.

An identical value is exempt when it has no letters outside `{{placeholders}}`,
or when the locale file lists its key in a top-level `_same_as_en` array — the
reviewable statement that the English text is correct in that language (a brand
name, a protocol term). A marker naming a key that no longer exists, whose value
was since translated, or that has no letters, fails the gate. `_same_as_en`
entries also count as translated for the three-state gate.

```json
{ "_same_as_en": ["brand.signal"], "brand": { "signal": "Signal" } }
```

## Structure

```
locales/          # JSON locale files, one per language (see languages.ts for the current list)
deferred.json     # Deferral record: locale -> keys knowingly carrying verbatim English
languages.ts      # Language metadata (codes, display labels, Twilio voice IDs)
tools/
  i18n-codegen.ts          # Generates iOS .strings + Android strings.xml + Kotlin I18n.kt; three-state gate
  deferral.ts              # Shared deferral-record logic (parse, hygiene, classify, sync)
  untranslated.ts          # Untranslated-value detector (letters rule, _same_as_en, merge-base diff, report)
  check-untranslated.ts    # `bun run i18n:untranslated` CLI: resolves the merge base, writes the job summary
  validate-strings.ts      # Cross-platform string reference validator
```

## Commands

```bash
bun run i18n:codegen           # Generate iOS .strings + Android strings.xml + Kotlin I18n.kt
bun run i18n:validate          # Check all locales for completeness
bun run i18n:validate:all      # Run all three validators (desktop, iOS, Android)
bun run i18n:validate:desktop  # Validate t('key') calls match en.json
bun run i18n:validate:ios      # Validate localized string refs in Swift
bun run i18n:validate:android  # Validate R.string.* refs match codegen output
```

## Adding a new string

1. Add the key and English value to `locales/en.json`
2. Add translations to all other locale files — or, if translation is deferred,
   copy the English value AND record the deferral (`bun run i18n:codegen --sync-deferral`
   after the copy; a verbatim-English value with no record entry fails the gate)
3. Run `bun run i18n:codegen` to regenerate platform files
4. Run `bun run i18n:validate:all` to check for missing keys

## Adding a new locale

1. Copy `locales/en.json` to `locales/<code>.json`
2. Run `bun run i18n:codegen --sync-deferral` to record every key as knowingly English
3. Translate values, removing each key's entry from `deferred.json` as you go
   (a translated value with its entry left behind fails the gate)
4. Add the locale entry to `languages.ts` (code, label, Twilio voice ID)
5. Run `bun run i18n:codegen` and `bun run i18n:validate:all`

## Platform output

Codegen writes to:
- `apps/ios/Sources/Generated/` — iOS `.strings` files
- `apps/android/app/src/main/res/values-*/strings.xml` — Android string resources
- `apps/android/app/src/main/java/.../I18n.kt` — Kotlin I18n constants

Generated output is gitignored in those directories — always regenerate via `bun run i18n:codegen`.
