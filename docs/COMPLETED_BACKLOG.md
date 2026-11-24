# Completed Backlog

> History only. New work is tracked in GitHub epics (planning index #2988).

## 2026-03-14: Case Management System (Epics 315-332)

### Architecture
- Template-driven entity/relationship schema engine with SugarCRM-level flexibility
- 2 new Durable Objects: ContactDirectoryDO (contacts, per-hub), CaseDO (records, per-hub)
- 3-tier E2EE: summary fields (searchable), custom fields (role-gated), PII (admin-only) with envelope-based RBAC
- Blind index system in Rust (HMAC + epoch bucketing for dates + trigram tokenization for names) in packages/crypto
- Telephony-CRM integration: caller identification via contact hash, screen pop with case history, auto-link notes to cases
- Evidence chain of custody with SHA-256 integrity verification and access logging
- Cross-hub case visibility with opt-in super-admin access and selective envelope sharing
- Support contact notifications via Signal/SMS/WhatsApp for case status updates

### Implementation Stats
- 22 commits, 110+ files, ~27,000 lines
- 13 pre-built templates: jail support, street medic, ICE rapid response, bail fund, DV crisis, anti-trafficking, hate crime, copwatch, tenant organizing, mutual aid, missing persons, KYR training, general hotline
- 16 new React components, 3 new routes (cases, contacts, case-timeline)
- 30 new permissions, 12 new crypto labels (domain separation constants)
- 57 backend BDD scenarios (all passing), 98 desktop BDD scenarios
- 6 reference documents in docs/plans/2026-03-14-case-management-*.md (~3000 lines)

### Epics Completed
- **Epic 315**: Entity Schema Engine — EntityTypeDefinition, RelationshipTypeDefinition, EnumDefinition, EntityFieldDefinition in SettingsDO with CRUD API
- **Epic 316**: Blind Index Infrastructure — HMAC blind indexes, epoch bucketing, trigram tokenization, Rust implementation
- **Epic 317**: Template System & Catalog — 13 JSON templates in packages/protocol/templates/, Zod validation at build time
- **Epic 318**: Contact Entity & E2EE Profiles — ContactDirectoryDO, encrypted profiles, blind index lookup/dedup, trigram search
- **Epic 319**: Record Entity & Core CRUD — CaseDO, generic record storage, 3-tier E2EE, case numbering, contact M:N linking
- **Epic 320**: Event Entity & Linking — Events with time/location/sub-events, configurable location precision, M:N linking
- **Epic 321**: CMS Permissions & RBAC — Entity-type-level access control, 3-tier envelope recipient logic, template-suggested roles
- **Epic 322**: Contact Relationships & Support Networks — Affinity groups, support contact graph, relationship types
- **Epic 323**: Case Interactions & Timeline — Notes/calls/conversations linked to cases, unified chronological timeline
- **Epic 324**: Report-Record-Event Linking — M:N between reports and case records, evidence association
- **Epic 325**: Evidence & Chain of Custody — File attachments with integrity hashes, custody chain metadata
- **Epic 326**: Telephony-CRM Screen Pop & Auto-Link — Caller identification, case history on ring screen
- **Epic 327**: Support Contact Notifications — Case status updates via messaging adapters
- **Epic 328**: Cross-Hub Case Visibility — Opt-in super-admin, cross-hub contact correlation
- **Epic 329**: Desktop Schema Editor & Template Browser — Admin UI for entity type/field/enum editing, template apply wizard
- **Epic 330**: Desktop Case Management UI — Schema-driven record list/detail/create, assignment, status, bulk operations
- **Epic 331**: Desktop Contact Directory — Contact list with trigram search, profile viewer, relationship graph, merge tool
- **Epic 332**: Desktop Case Timeline & Evidence Viewer — Chronological timeline, evidence gallery, chain of custody display

### Key Decisions
- Events are records with `category='event'` — no separate Durable Object needed
- Court dates: `next_court_date` (indexed via blind index) + `court_history` (narrative log field)
- "Blind index" never appears in user-facing text — UI uses "encrypted search"
- Templates are JSON in `packages/protocol/templates/`, validated by Zod at build time
- DV crisis template has ALL fields marked as PII tier (maximum privacy protection)
- Hub-per-scenario isolation planned for parallel test execution (Epic 334)
- Desktop BDD step definitions deferred to Epic 334; mobile views (iOS/Android) remain as future work

## 2026-03-08: BDD Workflow Overhaul (Epics 301-303)

### Epic 301: BDD Spec Reorganization + Backend BDD Suite
- Reorganized 94 feature files from per-screen layout to behavior-focused tiers: `core/` (7), `admin/` (6), `security/` (4), `platform/` (13)
- Rewrote 34 shallow UI-existence tests as behavioral scenarios verifying state/data
- Deleted 6 zero-value tests (screenshots, help screen, nav smoke, mocked admin)
- Created 8 backend BDD step definition files in `tests/steps/backend/` using simulation framework + API helpers
- Wired `backend-bdd` project into `playwright.config.ts` with separate `defineBddConfig` for `@backend` tags
- Added `test:backend:bdd` script and `scripts/test-backend-bdd.sh` runner
- Updated `scripts/lib/platform-detect.sh` to include `backend-bdd` as a platform
- Excluded `tests/steps/backend/` from desktop BDD config to prevent `createBdd()` conflicts
- Net scenario count: 575 → 585 (gained 10 new behavioral scenarios)

### Epic 302: Skills & Documentation Overhaul
- Updated `epic-authoring` skill: BDD-First Feature Epic template, AC→Gherkin mapping, self-review items 9-12, phased batch workflow
- Replaced `multi-platform-test-recovery` with `bdd-feature-development` skill: 3-phase workflow, Gherkin quality rules, backend step patterns, platform debugging tips preserved
- Updated `test-orchestration` skill: Backend BDD platform section, infrastructure map, shared spec structure
- Updated `cross-platform-feature-port` skill: "Read the BDD Spec" as Step 1, Red-Green-Refactor porting
- Updated `backend-api-development` skill: Backend BDD Testing section with simulation framework reference
- Rewrote CLAUDE.md working style: 3-Phase BDD Workflow, Test Philosophy, Pre-Commit Verification
- Updated MEMORY.md cardinal rule to "Tests Are The Spec", BDD-first workflow, trimmed to under 200 lines

### Epic 303: Integration Verification
- Scenario count verified: 585 total (575 before, +10 new behavioral, -6 deleted zero-value = net +4 accounting for consolidation)
- Typecheck passes with all new step definitions
- Zero-value files confirmed deleted, old directories removed
- .features-gen-backend/ added to .gitignore
- Instruction consistency audit: all 9 cross-file checks PASS (CLAUDE.md, 5 skills, MEMORY.md, package.json, playwright.config.ts)
- Dry-run scenario added: "Dashboard shows correct on-shift volunteer count" with backend step definition
- Android copyFeatureFiles compatible (recursive copy picks up new dirs)
- Backlog files updated

## 2026-03-08: Production Readiness Epics 276-300 (21/25 complete, 4 in progress)

### Track 1: Ansible Fleet Deployment (E276-E280) — COMPLETE
- **E276**: Multi-host Ansible inventory with per-service toggles, service discovery templates, matrix-docker-ansible-deploy pattern
- **E277**: Per-service backup roles (postgres, WebSocket relay, rustfs, config), cross-host aggregation, backup monitoring, restore playbook
- **E278**: Full observability stack (Prometheus, Grafana, Loki, Promtail, Alertmanager, Node Exporter) + lightweight healthcheck-only mode
- **E279**: Container watchdog with restart budgets, PostgreSQL VACUUM maintenance, NTP drift detection, cert/disk monitoring
- **E280**: Blue-green rolling updates with block/rescue auto-rollback, version tracking, dependency-ordered multi-host updates

### Track 2: Backend Resilience (E281-E285) — COMPLETE
- **E281**: DO storage sharding (volunteers→`vol:{pubkey}`, invites→`invite:{code}`, conversations→`conv:{id}`, files→`file:{id}`), cursor pagination, storage monitor, migrations v3-v6
- **E282**: `withRetry()` exponential backoff with jitter, circuit breaker (closed/open/half_open), Prometheus metrics, global registry
- **E283**: Zod schemas on all REST endpoints, `validateBody`/`validateQuery` Hono middleware
- **E284**: Structured logger with `child()` context, request ID middleware, error counters by category, DO alarm try/catch
- **E285**: TTL constants with admin overrides, cleanup in all DO alarms (expired sessions, challenges, invites, stale files, completed blast queues)

### Track 3: Data Migrations (E286-E287) — COMPLETE
- **E286**: Online migration framework with progress tracking, rollback, admin visibility (`GET /api/migrations`), CLI tooling, production guards
- **E287**: Multi-report-type system with per-type custom fields, admin CRUD UI, migration from flat categories, cross-platform

### Track 4: Client Lifecycle (E288-E293) — COMPLETE
- **E288**: API version negotiation via `X-API-Version` header, `apiVersion` middleware, forced/soft update flow on all 3 platforms
- **E289**: Tauri updater plugin with GitHub Releases + self-hosted fallback, Ed25519 signing, background checks, Playwright mock
- **E290**: (Previously completed) Mobile distribution with TestFlight, Play Store, F-Droid, direct APK
- **E291**: iOS `SFSpeechRecognizer` + Android `SpeechRecognizer` with on-device-only mode, permission handling
- **E292**: Offline resilience queue (localStorage), FIFO replay with exponential backoff, `OfflineQueuedError`, async auth headers
- **E293**: Client crash reporting with Sentry envelope upload, localStorage consent, global error/unhandledrejection handlers, iOS NSException+signal handlers, Android UncaughtExceptionHandler

### Track 5: Operations (partial — E297, E299 complete)
- **E297**: Security audit CI workflow (bun audit, cargo audit, Trivy container/config scanning), Ansible security-scan role with automated OS updates
- **E299**: Operator handbook (~1000 lines) + quick reference card, task-organized with troubleshooting trees

### Integration Notes
- All epics cherry-picked from isolated worktrees to `desktop` branch
- Fixed migration syntax error (duplicate `]` in migrations/index.ts)
- Restored `getContactSummaries`/`getContactConversations` methods lost during E281/E285 merge
- Fixed `now` variable scope in conversation-do.ts alarm method
- Fixed async `getHeaders` signature in offline queue replay

## 2026-03-08: Epic 290 — Mobile App Distribution & Update Management

### iOS Distribution Pipeline
- Enhanced `.github/workflows/mobile-release.yml` with crypto XCFramework build, xcodegen, manual code signing
- Committed `apps/ios/ExportOptions.plist` for App Store Connect archive export
- Created `apps/ios/fastlane/Fastfile` with beta (TestFlight) and release (App Store) lanes
- Version check: `APIService.checkVersionCompatibility()` fetches `/api/config` and compares `apiVersion`/`minApiVersion`
- `UpdateRequiredView` blocks the app when `minApiVersion` exceeds client version, with App Store link + admin contact fallback
- `UpdateBanner` shows dismissible soft-update notification with App Store link

### Android Distribution Pipeline
- Enhanced workflow with `cargo-ndk` crypto build, Play Store AAB upload via `r0adkll/upload-google-play`
- APK SHA-256 checksum generation and upload to GitHub Releases alongside APK
- Created `apps/android/fastlane/metadata/android/en-US/` (full/short description, title, changelogs)
- Created `apps/android/metadata/org.llamenos.hotline.yml` F-Droid build metadata with cargo-ndk prebuild
- `VersionChecker` singleton: fetches `/api/config`, compares `API_VERSION` constant against server
- `UpdateRequiredScreen` composable: blocks app with Play Store link + hub URL fallback
- `UpdateBanner` composable: dismissible Material 3 banner with Play Store link

### Client-Side Version Check (Both Platforms)
- iOS: wired into `LlamenosApp.onAppear` via `AppState.checkVersionCompatibility()`
- Android: wired into `LlamenosNavigation` via `LaunchedEffect(Unit)` + `VersionChecker.check()`
- Force-update blocks entire app; soft-update is dismissible banner above content
- Network failures return `.unknown` — app is never blocked when offline

### i18n
- Added `updates.*` section (6 keys) to all 13 locales
- Ran `bun run i18n:codegen` to generate iOS `.strings` + Android `strings.xml` + Kotlin `I18n.kt`

### Tests
- `VersionCheckerTest.kt`: 5 unit tests with OkHttp MockWebServer (UpToDate, ForceUpdate, UpdateAvailable, network error, server error)
- `VersionCheckTests.swift`: 7 unit tests for VersionStatus equality, API version constant, AppConfig decoding, unknown key handling

### Security
- Workflow uses env vars for user inputs (no direct `${{ }}` in run blocks)
- Version check uses separate plain JSONDecoder (server sends camelCase, not snake_case)

## 2026-03-07: Cross-Platform E2E Simulation & iOS API Tests

### E1: Fix iOS API Bootstrap (401 Auth)
- `CryptoService.setMockIdentity()` uses real admin keypair (f5450e...) matching Docker ADMIN_PUBKEY
- `bootstrapTestIdentity()` calls POST /api/auth/bootstrap to create admin volunteer
- `fetchUserRole()` uses /api/auth/me with roles array (not old /api/identity/me)
- `AuthMeResponse` updated to match actual server response structure
- All 10 API-connected iOS E2E tests pass serially in ~116s

### E2: Shared Call/Event Simulation Service
- 6 POST endpoints in apps/worker/routes/dev.ts: incoming-call, answer-call, end-call, voicemail, incoming-message, delivery-status
- Guarded by ENVIRONMENT=development + X-Test-Secret header
- Bypass TelephonyAdapter/MessagingAdapter, proxy directly to CallRouterDO/ConversationDO
- Verified working against Docker backend via curl

### E4: Desktop Playwright Simulation Migration
- tests/simulation-helpers.ts: typed helpers for all 6 endpoints with APIRequestContext
- tests/simulation.spec.ts: 11 tests (call lifecycle, message simulation, endpoint validation)
- uniqueCallerNumber() helper for test isolation

### E5: Android Simulation E2E
- SimulationClient.kt: HTTP client with kotlinx.serialization response types
- CallSimulationSteps.kt: Cucumber step definitions for 12 BDD scenarios
- call-simulation.feature: full call/message lifecycle scenarios
- Updated ScenarioHooks.kt and android-parallel-e2e.sh for test secret passing

### E3: iOS Test Migration to API-Connected (50 tests)
- Expanded APIConnectedUITests.swift from 10 to 50 test methods
- Added simulation helpers to BaseUITest.swift (simulateIncomingCall, simulateAnswerCall, simulateEndCall, simulateVoicemail, simulateIncomingMessage)
- Covers: bootstrap, dashboard, notes CRUD, shifts, settings, conversations, admin panel (volunteers/bans/audit/invites/custom-fields), reports, contacts, blasts, help, device link, call/message simulation
- All tests use BDD Given/When/Then style with serial execution

### E6: iOS Visual Audit & Bug Fixes
- 25 screenshot audit tests in ScreenshotAuditTests.swift covering every screen
- Fixed 6 hardcoded strings in PanicWipeConfirmationView → NSLocalizedString
- Fixed language names in SettingsView to use native script (Español, 中文, العربية, etc.)
- Added accessibility identifiers to BrandEmptyState, CopyableField, ContactTimelineView
- Added 6 panicWipe i18n keys to all 13 locales with codegen
- Visual audit report: docs/ios-visual-audit-2026-03-07.md

### Desktop Simulation URL Fix
- Fixed simulation-helpers.ts to use absolute backend URL (localhost:3000) instead of relative paths that would hit Vite frontend

### Design Doc
- docs/plans/2026-03-07-cross-platform-e2e-simulation-design.md

## 2026-03-07: iOS Feature Parity Epics 240, 243, 244, 245

### Epic 240: iOS Docker Test Infrastructure
- AppState already had `--test-hub-url`, `--test-register`, `--test-admin` launch arguments
- BaseUITest already had `launchWithAPI()`, `launchAsAdminWithAPI()`, `resetServerState()`, `testHubURL`
- Added Docker Compose lifecycle to `scripts/ios-build.sh` `cmd_uitest`: auto-starts Docker backend if not running, waits for health check, stops after tests

### Epic 243: iOS Contacts & Timeline
- Already complete: Contact.swift model (ContactSummary, ContactTimelineEvent, ContactEventType), ContactsViewModel with pagination/search, ContactTimelineViewModel, ContactsView with list/search/empty/loading/error states, ContactTimelineView with header and event rows, Route enum routes, Dashboard quick action (admin-only), ContactsUITests

### Epic 244: iOS Admin Custom Fields
- Already complete: CustomFieldDefinition model, CustomFieldsView with list/swipe-to-delete/tap-to-edit, CustomFieldEditView with label/type picker/context picker/options/toggles, AdminViewModel CRUD methods, AdminTab.customFields, AdminCustomFieldsUITests

### Epic 245: iOS Blasts
- Already had: Blast.swift model, BlastsViewModel, BlastsView, CreateBlastView, Route enum, Dashboard quick action, BlastsUITests
- Added `scheduleBlast(id:at:)` method to BlastsViewModel with ISO 8601 date formatting
- Added `ScheduleBlastRequest` model to Blast.swift
- Added Signal channel toggle to CreateBlastView (was only SMS + WhatsApp)
- Replaced single "Create" toolbar button with "Send Now" + "Schedule for Later" action buttons
- Added date picker that toggles when Schedule button is tapped
- Added "Confirm Schedule" button for scheduled sends
- Updated BlastsUITests: added `testScheduleButtonTogglesDatePicker` test, expanded `testCreateBlastSheetOpens` to verify Signal toggle + Send/Schedule buttons

### Files Modified
- `scripts/ios-build.sh` — Docker Compose start/stop/health-wait in cmd_uitest
- `apps/ios/Sources/Models/Blast.swift` — Added ScheduleBlastRequest
- `apps/ios/Sources/ViewModels/BlastsViewModel.swift` — Added scheduleBlast method
- `apps/ios/Sources/Views/Blasts/CreateBlastView.swift` — Signal channel, Send/Schedule actions, date picker
- `apps/ios/Tests/UI/BlastsUITests.swift` — Schedule date picker test, expanded form element assertions
- `docs/NEXT_BACKLOG.md` — Marked epics 240, 243, 244, 245 complete

## 2026-03-07: UX Bug Fixes — Pagination, Error Handling, Relay Reconnection

### Contacts Pagination Fix (CRITICAL)
- `contacts.tsx:286-294` — pagination buttons rendered but had NO onClick handlers; users could not navigate pages
- Added `useNavigate` and wired `onClick` to update `?page=` search param via TanStack Router

### Silent Error Handling
- Replaced `.catch(() => {})` with `.catch(() => toast(t('common.error'), 'error'))` in:
  - `notes.tsx` — custom fields, call history, volunteers loading
  - `calls.tsx` — volunteer list loading
  - `audit.tsx` — volunteer list loading, audit log fetching
  - `admin/settings.tsx` — WebAuthn, custom fields, telephony, messaging config loading

### NewNoteForm "Enter Manually" Bug Fix
- `new-note-form.tsx:75` had `value=""` hardcoded — when user selected "Enter Manually" and typed, input appeared frozen
- The onChange set callId to typed text, which made `callId !== '__manual'` immediately, hiding the manual input
- Fix: separate `manualCallId` state for the manual input, `effectiveCallId` for save

### Accessibility Fixes
- Added missing `aria-label` on delete buttons in SubscriberManager and custom-fields-section
- Added `htmlFor` linkage on native `<select>` labels in custom-fields-section

### Async Race Condition Guards
- Added `cancelled` flag to decrypt useEffects in `calls.tsx` and `notes.tsx` to prevent stale closures
- Added `hasUndecrypted` early-return to avoid re-running decrypt when all records are already decrypted

### Additional Silent Error Handling
- Dashboard calls-today count, volunteer detail page, settings page, note-sheet, reports list refresh

### WebSocket Relay Tab Visibility Reconnection
- Added `visibilitychange` listener to `WebSocketProvider` — when tab regains focus, proactively reconnects if WebSocket was killed by the browser during background
- Previously relied only on exponential backoff which could delay reconnection by up to 30s after tab refocus

## 2026-03-07: Test Suite Fix — PIN Entry for 8-Field PinInput

### enterPin Helper Fix
- PinInput was updated to 8 fields (minLength 6) but `enterPin()` test helper only typed 6 digits without pressing Enter
- Auto-complete only fires when all 8 digits are entered; 6-digit TEST_PIN never triggered `onComplete`
- Fix: added `page.keyboard.press('Enter')` after typing digits (Enter triggers onComplete when >= minLength)
- **Result: 380/380 Playwright tests pass (was 0/558 — every test failed at login)**

## 2026-03-07: API Resilience & Accessibility Hardening

### API Resilience (Desktop Client)
- Added request timeouts (15s default, 30s for uploads/downloads) via AbortController to ALL fetch calls
- Added retry with exponential backoff + jitter for GET requests (3 retries, 502/503/504/429)
- Added retry for upload chunks (2 retries) and file downloads (3 retries)
- New `NetworkError` class distinguishes network failures from server errors (ApiError)
- Added `isNetworkError()` helper for UI-level error classification
- Timeout + error handling added to every raw fetch caller: getConfig, bootstrapAdmin, validateInvite, redeemInvite, uploadIvrAudio, uploadChunk, downloadFile, getCallRecording
- Previously: zero timeouts, zero retries, network errors thrown as unclassified TypeError

### Accessibility (WCAG role="alert")
- Added `role="alert"` to 14 error message elements across login, PIN input, settings, file preview, recording player, phone validation, custom fields, link-device, preferences
- Screen readers now announce error messages immediately when they appear
- Files: login.tsx (4), link-device.tsx (2), settings.tsx (3), pin-challenge-dialog.tsx, phone-input.tsx, custom-field-inputs.tsx, FilePreview.tsx, recording-player.tsx, preferences.tsx

### Accessibility (ARIA Labels)
- Added aria-labels to icon-only buttons: custom field reorder (moveUp/moveDown), getting-started collapse toggle
- Added `a11y.moveUp` and `a11y.moveDown` keys to all 13 locales + codegen output

## 2026-03-07: Security & Reliability Improvements

### Node.js Platform Env Fix
- Fixed `DEV_RESET_SECRET` / `E2E_TEST_SECRET` not being passed through `createNodeEnv()` to Hono `c.env`
- Added `X-Test-Secret` header to Playwright global-setup.ts
- Added `DEV_RESET_SECRET=test-reset-secret` to `docker-compose.test.yml`
- **367/367 Playwright E2E tests now pass against Docker** (was 0/367 due to 403 from test-reset)

### PIN Length Hardening (4-6 → 6-8 digits)
- Per security review: 4-digit PINs (~13 bits entropy) brute-forceable in minutes
- Updated across ALL platforms: Rust crypto, Desktop, iOS, Android
- Rust `is_valid_pin()` now accepts 6-8 digits, 45/45 tests pass
- Desktop `PinInput` component: 8 boxes, `minLength=6`, Enter key submits at 6+
- iOS: AuthService, PINViewModel, PINPadView validation updated
- Android: CryptoService, PINPad, PINSetScreen validation updated
- i18n: All 13 locales updated (JSON, .strings, strings.xml)
- Protocol docs, security docs, threat model updated
- 65/65 PIN/auth BDD tests pass

### React Error Boundary
- Added `ErrorBoundary` component with retry button and i18n support
- Root-level boundary catches top-level crashes
- Page-level boundary wraps Outlet (sidebar survives page crashes)
- Error message + "Try again" button vs. blank white screen

### Sliding Session Expiry
- Server now extends session by 8 hours on each validated request (after first hour of use)
- Active volunteers never hit session expiry during their 4-8 hour shifts
- Client idle warning threshold raised from 4 minutes to 30 minutes
- 70/70 auth/session BDD tests pass

### Offline Connectivity Banner
- Red alert banner appears when browser loses network connectivity
- Uses browser online/offline events — zero overhead when online
- Critical for crisis workers who need instant awareness of connection loss

### Additional Node.js Platform Fixes
- Added `DEMO_RESET_CRON` and `NOSTR_RELAY_PUBLIC_URL` to `createNodeEnv()`
- Systematic audit of all `c.env` vars used in Worker routes vs. what Node.js env passes through

### Final Test Results
- **382/382 Playwright E2E tests pass** against Docker (0 failures)
- All Rust crypto tests pass (45/45)
- i18n validation passes across all platforms

## 2026-03-06: i18n System Overhaul (Epics 274-275)

### Epic 274: Canonicalize en.json Source of Truth
- Removed 52 within-object duplicate keys (snake_case variants alongside camelCase)
- Merged flat top-level keys into nested objects (`device_link` → `deviceLink`, `panic_wipe` → `panicWipe`, etc.)
- Updated codegen (`i18n-codegen.ts`) to convert camelCase→snake_case for iOS .strings + Android strings.xml
- Updated validator (`validate-strings.ts`) to match new codegen behavior
- 1,695 keys across 13 locales, all pure snake_case after codegen

### Epic 275: Align Mobile i18n References
- iOS: Fixed 4 invalid refs (`settings_lock_1min` → `settings_lock1min`, etc.)
- Android: Fixed 138 invalid refs — singular→plural prefixes (`shift_` → `shifts_`, `call_` → `calls_`, etc.)
- Propagated 9 new keys to all 12 non-English locales
- All 3 platform validators (`bun run i18n:validate:all`) pass with 0 errors

## 2026-03-06: iOS UX Overhaul — "Quiet Authority" Design System (Epics 269-273)

### Epic 269: Design System Foundation
- **BrandColors.swift**: 15 semantic colors (primary, accent, surface, text, status indicators) with light/dark mode support
- **Asset Catalog**: Color sets for all brand colors, Logo.imageset with SVG
- **DM Sans typography**: System-wide font migration via UINavigationBar appearance + LoadingOverlay brand tinting
- **Shared components**: BrandCard, StatusDot, BadgeView, CopyableField, Banner, EmptyState, AvatarView, StepIndicator
- **Utility extensions**: View+Brand, Color+Brand, String truncation helpers

### Epic 270: Auth Flow Redesign
- **LoginView**: Custom logo, "End-to-end encrypted" tagline, async hub URL validation with real connectivity check
- **AuthViewModel**: `validateAndStoreHubURL()` with `apiService.validateConnection()`, `--test-skip-hub-validation` flag for XCUITests
- **PINPadView**: Haptic feedback on digit tap, refined spacing and brand colors
- **ImportKeyView**: Security note about on-device encryption, improved layout

### Epic 271: Dashboard & Tab Bar Overhaul
- **DashboardView**: Quick action cards (Calls, Notes, Help) with accessibility identifiers
- **Shift status card**: Branded styling with StatusDot indicators
- **Tab bar**: Brand-tinted selection

### Epic 272: Feature Screens Polish
- **Reports, Blasts, Contacts**: BrandCard-based layouts
- **Dashboard quick actions**: Proper accessibility identifiers for XCUITest targeting

### Epic 273: Settings, Admin & Shared Polish
- **SettingsView restructure**: Navigation hub → AccountSettingsView (identity, hub URL, device link) + PreferencesSettingsView (notifications, language, security)
- **PanicWipeConfirmationView**: Multi-step friction gate — type "WIPE" in TextField + final alert with "Yes, Wipe Everything" destructive button
- **Admin cards**: Brand-styled NavigationLinks
- **Help screen**: Accordion-style DisclosureGroup sections
- **Device link**: Brand-colored status indicators

### XCUITest Updates (118/118 pass, 98 unit tests pass)
- Added `navigateToAccountSettings()` / `navigateToPreferencesSettings()` helpers to BaseUITest
- Updated `settings-admin-panel` → `settings-admin-link` across all admin test suites
- Device link + pubkey tests routed through account settings sub-page
- Auto-lock picker test routed through preferences settings sub-page
- PanicWipe test handles friction gate (type "WIPE" + alert confirmation)
- `--test-skip-hub-validation` flag bypasses hub connectivity check for fake URLs
- AuthFlowUITests enter hub URL before import/create flows
- SecurityHardeningTests: async `startImport()` → direct state assignment

### i18n Additions
- `dashboard.calls`, `dashboard.notes`, `dashboard.help` — quick action labels
- `error.hub_unreachable` — hub connectivity error
- `import.security_note` — on-device encryption explanation
- `login.encrypted_tagline` — "End-to-end encrypted"
- `settings.account_title`, `settings.preferences_title` — sub-page titles
- All 13 locales updated, Android codegen output synced

### Rust Crypto
- `keypair_from_secret_key_hex()` added to `packages/crypto/src/keys.rs` with roundtrip test

## 2026-03-05: Android Tooling Upgrade — Epic 268

### Epic 268: Android Tooling Upgrade
- **Gradle**: 8.9 → 9.4.0
- **AGP**: 8.7.3 → 9.1.0 (built-in Kotlin — removed `kotlin-android` plugin)
- **Kotlin**: 2.0.21 → 2.3.0
- **KSP**: New (2.3.6) — fully replaced kapt (removed `kotlin-kapt` plugin, `kapt {}` block, all `kapt()` deps)
- **Compose BOM**: 2024.12.01 → 2026.02.01
- **compileSdk/targetSdk**: 35 → 36
- **Hilt**: 2.53.1 → 2.59.2 (kapt→KSP, AGP 9 required)
- **OkHttp**: 4.12.0 → 5.3.2
- **Navigation**: 2.8.5 → 2.9.7
- **Coroutines**: 1.9.0 → 1.10.2
- **Lifecycle**: 2.8.7 → 2.10.0
- **Activity Compose**: 1.9.3 → 1.12.4
- **kotlinx-serialization**: 1.7.3 → 1.10.0
- **Core KTX**: 1.15.0 → 1.17.0
- **CameraX**: 1.4.1 → 1.5.1
- **JNA**: 5.17.0 → 5.18.1
- **Hilt Navigation**: 1.2.0 → 1.3.0
- **compose-ui-test**: Removed standalone version, now managed by BOM
- Migrated `kotlinOptions { jvmTarget = "17" }` → `kotlin { compilerOptions { jvmTarget = JvmTarget.JVM_17 } }`
- Fixed deprecated `jniLibs.srcDirs()` → `jniLibs.directories.add()`
- Verified on Mac M4: assembleDebug, testDebugUnitTest, lintDebug, compileDebugAndroidTestKotlin — all pass

## 2026-03-05: Tooling & Test Orchestration — Epics 265-267

### Epic 265: i18n Android String Alignment
- **328 unresolved R.string references** in 35 Kotlin files — all resolved
- 327 strings added to en.json (137 nested in existing sections, 190 as top-level flat keys)
- 1 Kotlin ref corrected: `R.string.logout` → `R.string.common_logout` (section conflict)
- All 13 locales propagated: 1761 keys each, all complete
- Verified: Android unit tests pass, lint clean, androidTest compiles, iOS builds, desktop typecheck + build pass

### Epic 266: i18n Codegen Validation Enhancement
- **validate-strings.ts**: Cross-platform string reference validator (android/ios/desktop/all subcommands)
- Android validator: scans R.string.* refs in Kotlin, compares against codegen output
- iOS validator: scans NSLocalizedString/String(localized:) patterns in Swift
- Desktop validator: scans t('key') calls in TS/TSX, warns on dynamic keys without failing
- **I18n.kt**: Generated Kotlin constants object (1761 keys) with English text comments
- Allowlist support via validate-allowlist.json for non-i18n resources
- Fixed codegen to escape newlines/quotes in Kotlin comments
- All validators pass on current codebase (zero false positives)
- Added package.json scripts: i18n:validate:{android,ios,desktop,all}

### Epic 267: BDD Test Orchestration Overhaul
- **8 test scripts**: test-orchestrator, test-desktop, test-ios, test-android, test-worker, test-crypto, test-feature, test-changed
- **3 lib scripts**: codegen-guard.sh, platform-detect.sh, test-reporter.sh
- All scripts support --verbose, --no-codegen, --json, --timeout flags
- Codegen guard runs before tests, prevents stale codegen false failures
- Platform detection: auto-detects Mac vs Linux, available tools
- test-reporter: structured summary blocks, cargo/xcodebuild/playwright parsers
- test-orchestrator: parallel platform execution with aggregated results
- test-changed: git-diff-based incremental testing
- Docker Compose E2E overlay (docker-compose.e2e.yml) for per-platform hub isolation
- Added package.json scripts: test:{all,desktop,ios,android,worker,crypto,feature,changed}
- Verified: test:crypto and test:all (crypto) pass with correct output formatting

## 2026-03-05: Security Audit Round 8 — Epics 257-264

63 vulnerabilities found (8 Critical, 22 High, 33 Medium). All fixed across 8 epics.

### Epic 264: CI/CD & Supply Chain Hardening
- **ci.yml**: SHA-pinned all GitHub Actions, added `bun audit` with tiered thresholds (critical=0, high=5, moderate=20)
- **desktop-e2e.yml**: SHA-pinned actions
- **mobile-release.yml**: SHA-pinned actions
- **tauri-release.yml**: SHA-pinned actions, fixed missing Rust target on Linux
- **docker-compose.yml**: Digest-pinned base images (postgres, rustfs, redis)
- **ansible/vars.example.yml**: Fixed hardcoded SSH port, added SSH key path variable
- **dev-node.sh**: Auto-generate random HMAC_SECRET for dev if not set

### Epic 263: Protocol & Schema Hardening
- **Protocol schemas**: Added maxLength, pattern, format constraints to notes, files, hub, blasts schemas
- **PROTOCOL.md**: Removed legacy unbound auth token documentation
- **i18n-codegen.ts**: Added XML entity escaping for Android strings.xml output
- **Codegen**: Regenerated TS/Swift/Kotlin types with new schema constraints

### Epic 259: Rust Crypto & KDF Hardening
- **ecies.rs**: ECIES KDF v1→v2 migration (SHA-256 → HKDF-SHA256) with version byte `0x02`, v1 fallback for existing ciphertext, `ecies_unwrap_key_versioned` returns migration flag, sk_bytes zeroization
- **auth.rs**: `verify_auth_token_with_expiry()` with max_age_ms + 30s future clock rejection, `verify_schnorr` message length validation (must be 32 bytes)
- **encryption.rs**: `Zeroizing<Vec<u8>>` wrapper for all decrypt plaintext, PBKDF2 salt upgraded to 32 bytes (backward compatible with 16-byte)
- **ffi.rs**: Replaced manual HMAC HKDF with `hkdf` crate in `compute_sas_code`, added `ecies_encrypt_content_hex` FFI export
- **errors.rs**: Added `InvalidInput(String)` variant to CryptoError
- **Worker crypto.ts**: Mirrored ECIES HKDF v2 with version byte
- **file-crypto.ts**: Mirrored ECIES HKDF v2 metadata encryption
- All 55 Rust tests pass (44 unit + 11 interop)

### Epic 257: Desktop Tauri & Frontend Security Hardening
- **tauri.conf.json**: CSP hardened (form-action/frame-ancestors/base-uri/object-src blocked), Stronghold PBKDF2-SHA256 600K iterations with domain-separated salt
- **lib.rs**: CryptoState lock on window destroy and quit, zeroize on exit
- **crypto.rs**: One-time provisioning token (`request_provisioning_token` + `.take()` consumption), PIN lockout persisted in Tauri Store (escalating: 30s→2min→10min→wipe at 10 attempts)
- **api.ts**: returnTo validation (regex `/^\/[^/:]`) prevents open redirects
- **demo-accounts.ts**: Dynamic import for demo nsecs (separate chunk, not in main bundle)
- **tauri-core.ts mock**: Production guard throws if loaded outside PLAYWRIGHT_TEST

### Epic 258: Worker Critical & High Security Fixes
- **config.ts**: Removed `serverEventKeyHex` from public `/api/config` endpoint
- **auth.ts**: Moved `serverEventKeyHex` behind authentication (`/api/auth/me`), removed admin signing pubkey exposure (H17), IP-based rate limiting on login (10/min) and bootstrap (5/min)
- **blast-do.ts, records-do.ts, settings-do.ts**: DEMO_MODE gating on all reset handlers (C3)
- **settings-do.ts**: Rate limit parameter validation (key regex, maxPerMinute 1-1000)
- **provisioning.ts**: Rate limiting on room polling (30/min per IP) + token requirement
- **setup.ts**: All routes gated with `requirePermission('settings:manage')`

### Epic 262: Worker Medium Security Fixes
- **cors.ts**: Explicit origin allowlist (4 production origins + dev localhost only when ENVIRONMENT=development)
- **blast-do.ts**: Daily blast rate limit enforcement (maxBlastsPerDay, default 10, 429 on exceed), constant-time preference token lookup via storage index
- **records-do.ts**: actorPubkey format validation (64-char hex or 'system')
- **settings-do.ts**: Hub settings allowlist (strip unknown keys)
- **provisioning.ts**: IP-based polling rate limit (30/min)
- **uploads.ts**: Upload size caps (100MB total, 10MB per chunk)
- **dev.ts**: Inverted reset default — deny when no secret configured
- **setup.ts**: Setup state endpoint gated on permission

### Epic 260: iOS Security Hardening
- **KeychainService.swift**: Biometric PIN storage (storePINForBiometric/retrievePINWithBiometric with .biometryCurrentSet), PIN lockout persistence via Keychain (setLockoutAttempts/getLockoutUntil — not UserDefaults)
- **PINViewModel.swift**: Fixed biometric unlock (retrieves PIN from biometric Keychain, calls unlockWithPIN), escalating lockout (1-4 none, 5-6 30s, 7-8 2min, 9 10min, 10+ wipe)
- **DeviceLinkViewModel.swift**: SAS gate (pendingEncryptedNsec held until SAS confirmed), relay URL validation (isValidRelayHost rejects private IPs/loopback/link-local)
- **APIService.swift**: HTTP scheme rejection (throws insecureConnection), CertificatePinningDelegate (URLSessionDelegate with SHA-256 SPKI pin verification), auto-prepend https://
- **WakeKeyService.swift**: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly + kSecAttrSynchronizable=false (prevents iCloud sync)
- **LlamenosApp.swift**: @AppStorage("autoLockTimeout") for configurable auto-lock, privacy overlay on scenePhase .inactive/.background
- **OnboardingView.swift, NoteDetailView.swift**: .privacySensitive() on nsec display and note content
- **AuthViewModel.swift**: Clear nsecInput after successful import
- **SettingsView.swift**: Persist auto-lock timeout via @AppStorage with onChange handler
- **Tests**: SecurityHardeningTests.swift (31 unit tests: URL validation, lockout timing, HTTP rejection, cert pinning), KeychainServiceTests.swift (6 lockout persistence tests), SecurityUITests.swift (4 XCUITest stubs)

### Epic 261: Android Security Hardening
- **CryptoService.kt**: Removed ALL placeholder/fallback crypto paths (C6 hard-fail). Every crypto method now has `check(nativeLibLoaded)` — throws `IllegalStateException` without native lib. Removed Base64/String.hashCode() fallback for PIN encryption. Added `setTestKeyState()` for JVM test support.
- **KeystoreService.kt**: PIN brute-force protection (H9) with escalating lockout: 1-4 none, 5-6 30s, 7-8 2min, 9 10min, 10+ wipe. `PinLockoutState` sealed class, `recordFailedAttempt()`, `checkLockoutState()`, `resetFailedAttempts()`. StrongBox backing (H12) with graceful fallback.
- **AuthViewModel.kt**: Clear nsec from state after backup confirmation (H-2a), clear nsecInput after import (M29), clear PIN after encryption. Integrated PIN lockout state into UI (lockout/wipe errors, attempt tracking).
- **DeviceLinkViewModel.kt**: `isValidRelayHost()` rejects private IPs (10.x, 192.168.x, 172.16-31.x, 169.254.x, localhost, ::1, fe80:) to prevent SSRF/relay injection (H10).
- **ApiService.kt**: Certificate pinning via OkHttp `CertificatePinner` with placeholder pins referencing `docs/security/CERTIFICATE_PINS.md` (H14).
- **AuthInterceptor.kt**: Returns synthetic 401 Response instead of dispatching unauthenticated requests when signing fails (M30).
- **libs.versions.toml**: Upgraded security-crypto from 1.1.0-alpha06 to 1.1.0 stable (H11).
- **network_security_config.xml**: Removed dev IPs (192.168.x, 10.x) from release config (H13). Created debug source set overlay with dev IPs.
- **proguard-rules.pro**: Narrowed overly broad `-keep class org.llamenos.hotline.crypto.** { *; }` and `-keep class org.llamenos.hotline.api.** { *; }` to specific `-keepclassmembers` for API models and `@Serializable` classes (M31).
- **Tests**: CryptoServiceTest (17 tests verifying hard-fail for each method), KeystoreServiceTest (lockout escalation schedule, constants), DeviceLinkViewModelTest (23 URL validation tests), AuthInterceptorTest (5 synthetic 401 tests), AuthViewModelTest (updated for C6).

### Cross-Platform
- **CERTIFICATE_PINS.md**: Created shared certificate pin reference document
- All platforms use same ECIES v2 format with version byte detection and v1 fallback

## 2026-03-04: Security Audit Round 7 — Epics 252-256

### Epic 252: WebSocket Hub-Key Encryption
- **hub-event-crypto.ts** (CREATED): `deriveServerEventKey()` HKDF from SERVER_NOSTR_SECRET, `encryptHubEvent()` XChaCha20-Poly1305
- **WebSocket-events.ts**: Updated shared `publishWebSocketEvent()` to encrypt content when SERVER_NOSTR_SECRET is available
- **call-router.ts**: Updated private `publishWebSocketEvent()` with cached event key + encryption
- **config.ts**: Expose `serverEventKeyHex` to authenticated clients for decryption

### Epic 253: Invite Role Authorization
- **invites.ts**: Added role permission validation — creators cannot grant roles with permissions they don't have (prevents privilege escalation via invite)

### Epic 254: Remove Auth Token Fallback
- **auth.ts**: Removed unbound Schnorr token fallback — method+path binding now required for all auth tokens
- **auth-utils.test.ts**: Updated tests to verify unbound tokens are rejected

### Epic 255: Encrypt Contact Identifiers
- **crypto-labels.json/ts/rs**: Added `LABEL_CONTACT_ID` = `llamenos:contact-identifier` (29 labels total)
- **crypto.ts**: Added `encryptContactIdentifier()` and `decryptContactIdentifier()` with "enc:" prefix for versioning
- **conversation-do.ts**: Contact identifiers encrypted at rest, lazy migration for legacy plaintext values

### Epic 256: Fix BlastDO HMAC Keys
- **blast-do.ts**: Fixed `generatePreferenceToken()` and `importSubscribers()` to use `hexToBytes(this.env.HMAC_SECRET)` instead of public constant strings

### Codegen & Cross-Platform
- `bun run codegen` propagated LABEL_CONTACT_ID to TS, Swift, Kotlin generated files
- `packages/crypto/src/labels.rs` updated with LABEL_CONTACT_ID + test assertion
- All Rust tests pass (11/11), typecheck passes, build succeeds

## 2026-03-04: iOS Reports + Real Rust Crypto (Epic 241 + FFI stub removal)

### Epic 241: iOS Reports
- **Report.swift**: Model with `ReportStatus` enum (waiting/active/closed), `ReportStatusFilter`, `ReportResponse`, request types
- **ReportsViewModel.swift**: `@Observable` ViewModel with CRUD, status filtering, E2EE encryption via CryptoService
- **ReportsView.swift**: List view with filter menu, create button, empty/loading/error states, pull-to-refresh
- **ReportCreateView.swift**: Sheet with title, category picker, body editor, submit/cancel toolbar
- **ReportDetailView.swift**: ScrollView with status/category chips, metadata card, claim/close actions
- **ReportFlowUITests.swift**: 7 BDD tests — list content, create button, create flow, cancel, filter, dashboard action, empty state
- **DashboardView.swift**: Added `reportsQuickAction` NavigationLink card
- **Router.swift**: Added `.reports` and `.reportDetail(id)` route cases
- **ContentView.swift**: Added switch cases for new routes
- **SettingsView.swift**: Added `"reports"` navigation destination

### Real Rust Crypto (FFI Stub Removal)
- **Built real XCFramework** from `packages/crypto/scripts/build-mobile.sh ios` on Mac M4
- **Replaced stub XCFramework** with real Rust crypto (247 exported symbols vs stub's abort() calls)
- **Updated generated bindings**: `Sources/Generated/LlamenosCore.swift` from UniFFI bindgen output
- **CryptoService.swift**: Replaced XOR/placeholder stand-ins with real FFI calls:
  - `deriveSharedSecret()` → `computeSharedXHex()` (real ECDH)
  - `decryptWithSharedSecret()` → `decryptWithSharedKeyHex()` (real XChaCha20-Poly1305)
  - `deriveSASCode()` → `computeSasCode()` (real SAS derivation)
- **WakeKeyService.swift**: Removed `#if canImport(LlamenosCore)` conditionals, now uses real FFI:
  - `decryptWakePayload()` → `eciesDecryptContentHex()` (real ECIES decryption)
  - `derivePublicKey()` → `getPublicKey()` (real secp256k1)
- **DeviceLinkViewModel.swift**: Updated callers for now-throwing crypto methods

### Test Results (91 tests, 89 pass, 2 pre-existing failures)
- All new ReportFlowUITests: 7/7 pass
- All existing tests continue to pass (HelpUITests 4/4, PanicWipeUITests 4/4, etc.)
- 2 pre-existing failures: SettingsUITests (logout button off-screen layout issue)

## 2026-03-04: iOS Feature Parity — Help Screen & Panic Wipe (Epics 242, 246)

### Epic 242: iOS Help Screen
- **HelpView.swift**: Security overview section, volunteer guide, admin-only guide (role-gated), FAQ sections with DisclosureGroup
- **HelpUITests.swift**: 4 BDD tests — security section, volunteer guide, admin guide (role guard), FAQ sections
- Navigation via `settings-help` NavigationLink → `.navigationDestination(for: String.self)`
- All content uses `NSLocalizedString` for i18n readiness

### Epic 246: iOS Panic Wipe
- **PanicWipeConfirmationView.swift**: Two-step confirmation screen (red destructive button + cancel)
- 8-step data wipe: keychain, crypto lock, UserDefaults, WebSocket disconnect, wake key cleanup, app state reset, URL cache, cookies
- **PanicWipeUITests.swift**: 4 BDD tests — button exists, confirmation screen, wipe returns to login, cancel returns to settings
- Test-only `"test-panic-wipe"` NavigationLink at top of SettingsView to work around SwiftUI List cell recycling XCUITest bug on iOS 26
- **CryptoService.setMockIdentity()**: `#if DEBUG` method for test mode, bypasses FFI calls with hardcoded mock values

### Test Results (91 tests, 89 pass)
- All new tests pass: HelpUITests 4/4, PanicWipeUITests 4/4, ReportFlowUITests 7/7
- No regressions in existing test suites
- 2 pre-existing failures: SettingsUITests (logout button layout issue)

## 2026-03-03: Production Deployment & Node.js Primacy (Epics 235-237)

### Epic 235: Node.js Platform E2E Test Parity
- **79 integration tests** in `tests/integration/node/`: postgres-storage (29), alarm-poller (10), websocket-shim (17), blob-storage (9), migration (14)
- **17 pass** without external deps (WebSocket shim), 62 skip gracefully when PostgreSQL/RustFS unavailable
- **playwright.docker.config.ts** targeting Docker Compose Node.js server directly (no Vite)
- **vitest.integration.node.config.ts** with 30s timeouts and path aliases
- **CI jobs**: `e2e-node` (Playwright against Docker), `integration-node` (PostgreSQL + RustFS service containers)
- **npm script**: `test:integration:node`
- Commit: `99c96f2`

### Epic 236: Node.js Production Deployment Primacy & Infrastructure Hardening
**Phase 1-3 (Health, Docker, Dev Tooling):**
- **Health endpoint**: `apps/worker/routes/health.ts` — `/health` (dependency checks), `/health/live` (liveness), `/health/ready` (readiness). Platform-aware: PostgreSQL checked only on Node.js
- **Docker**: WebSocket relay pinned to 1.0.1, JSON logging driver (50MB rotation, 5 files), health check → `/api/health/ready`
- **Dockerfile**: replaced fragile `sed` workspace stripping with Node.js JSON manipulation
- **Caddyfile**: JSON access logging to stdout
- **esbuild**: conditional sourcemaps (`process.env.NODE_ENV !== 'production'`)
- **first-run.sh**: one-command setup (secret generation, env validation, stack startup, health wait)
- **docker-compose.dev.yml**: backing services only (PostgreSQL, RustFS, WebSocket relay) with localhost ports

**Phase 4-6 (Helm, Ansible, OpenTofu):**
- **Helm chart 0.2.0**: RustFS Deployment → StatefulSet (data loss protection), HPA (CPU 70%, memory 80%), PDB (app + WebSocket relay), ServiceMonitor for Prometheus, split liveness/readiness probes
- **Ansible**: RustFS backup via `mc mirror` in backup role, `playbooks/test-restore.yml` for restore verification
- **OpenTofu**: `admin_ssh_cidrs` variable replacing hardcoded `0.0.0.0/0` in Hetzner firewall

**Phase 7-9 (Observability, Dev Server, Checklist):**
- **Structured logger**: `apps/worker/lib/logger.ts` — JSON output on Node.js, console methods on CF Workers
- **Prometheus metrics**: `apps/worker/routes/metrics.ts` — uptime, counters, summaries at `/api/metrics`
- **Dev server**: `scripts/dev-node.sh` (`bun run dev:node`) — starts backing services, builds, runs with `--watch`
- **Production checklist**: `deploy/PRODUCTION_CHECKLIST.md` — 50+ items across infrastructure, security, backups, telephony, Kubernetes
- Commit: `99c96f2`

### Epic 237: iOS Build Pipeline on Local Mac M4
- **scripts/ios-build.sh** created with 8 commands: status, setup, sync, build, test, xcframework, uitest, all
- **npm scripts**: `ios:status`, `ios:setup`, `ios:sync`, `ios:build`, `ios:test`, `ios:xcframework`, `ios:uitest`, `ios:all`
- **Mac M4**: macOS 26.2, Xcode 26.2, Swift 6.2.4, Rust via asdf, iOS Simulator 26.2 runtime installed
- **ios-build.sh updates**: xcodebuild with scheme `Llamenos-Package`, `find_simulator()` dynamic detection, `REMOTE_INIT` for SSH PATH
- Commit: `99c96f2`, updated `10b720a`

### Epic 214-iOS: Link UniFFI XCFramework
- **XCFramework built** on Mac M4 via `packages/crypto/scripts/build-mobile.sh ios` (arm64 + arm64-simulator slices)
- **Package.swift**: Added `LlamenosCoreFFI` binary target pointing to local XCFramework
- **CryptoService.swift**: Complete rewrite — 10 real FFI functions replacing stand-in mocks (generateKeypair, importNsec, encryptForStorage, decryptFromStorage, createAuthToken, encryptNote, decryptNoteContent, encryptMessage, decryptMessage, lock)
- **LlamenosCoreExtensions.swift**: Codable conformance for UniFFI-generated types (EncryptedKeyData, AuthToken, EncryptedNote, etc.)
- **Generated bindings**: 1719-line `LlamenosCore.swift` from UniFFI bindgen
- Commit: `adce653`

### Epic 227: iOS BDD E2E Foundation
- **BaseUITest.swift**: Shared base class with BDD helpers (`given`/`when`/`then`/`and` via `XCTContext.runActivity`), launch modes (`launchClean`, `launchAuthenticated`, `launchAsAdmin`), tab navigation, PIN entry helpers
- **Test infrastructure**: Tab bar indices (0=Dashboard...4=Settings), launch arguments (`--reset-keychain`, `--test-authenticated`, `--test-admin`), element wait helpers
- Commit: `5f798ed`

### Epic 234: iOS BDD Test Expansion
- **126 test methods** across 10 test files (up from 76 across 7):
  - CryptoServiceTests: 36 tests (19 existing + 17 interop tests with test vectors)
  - DashboardUITests: 12 tests (NEW — connection status, shift card, tab navigation, lock flow)
  - SettingsUITests: 16 tests (NEW — npub, hub URL, lock/logout, copy buttons, toggles)
  - SecurityUITests: 5 tests (NEW — emergency wipe, PIN pad digits, wrong PIN, dots indicator)
  - KeychainServiceTests: 14 tests (existing)
  - AuthFlowUITests: 9, AdminFlowUITests: 11, NoteFlowUITests: 7, ConversationFlowUITests: 6, ShiftFlowUITests: 10 (existing)
- **Crypto interop**: Cross-platform test vector verification (auth tokens, ECIES wrap/unwrap, note/message/draft encryption, PIN encrypt/decrypt)
- **Build verified**: `xcodebuild build` + 36/36 CryptoServiceTests passing on Mac M4 (iPhone 17 simulator, Xcode 26.2)
- **Build fixes**: Color.tertiary type mismatch, BiometricPrompt switch exhaustiveness, test-vectors.json nsec regeneration
- Commits: `5f798ed`, `10b720a`

## 2026-03-03: E2E Test Coverage Consolidation (Epics 231-233)

### Epic 231: Shared BDD Spec Consolidation
- **5 features promoted** from Android-only to shared `packages/test-specs/features/`: `calls-today`, `language-selection`, `note-thread`, `shift-detail`, `volunteer-profile`
- **5 features expanded**: `roles.feature` (+19 → 27 total), `conversations-full.feature` (+9 → 16 total), `device-link.feature` (+4 → 10 total), `multi-hub.feature` (+1 → 6 total), `help-screen.feature` (+4 → 9 total)
- **validate-coverage.ts** fixed: iOS path scanning, added per-platform tag counting, untagged feature warnings, duplicate feature name detection
- **Android mirror synced**: all promoted/modified features copied, `admin/shift-detail.feature` → `shifts/shift-detail.feature`
- Commit: `8f2bd6a`

### Epic 232: Desktop Spec-to-BDD Migration
- **31 spec files deleted** (was 39 total, now 8 remaining infrastructure specs)
- **13 new step definition files** created in `tests/steps/`
- **4 new feature files**: `admin-flow.feature` (17 scenarios), `auth-guards.feature` (7), `login-restore.feature` (10), `pin-challenge.feature` (3)
- **2 features expanded**: `telephony-provider.feature` (5→10), `webrtc-settings.feature` (3→10)
- Commit: `296efd9`

### Epic 233: Worker Backend Test Suite
- **295 unit tests** across 13 test files in `apps/worker/__tests__/unit/`: permissions (55), ssrf-guard (34), helpers (30), crypto-utils (30), auth-utils (28), do-router (21), messaging-adapter (21), telephony-adapter (19), WebSocket-publisher (16), audit-chain (14), crypto-labels (12), do-access (9), permission-guard (6)
- **8 backend BDD feature files** in `packages/test-specs/features/backend/`: auth-verification, permission-system, do-routing, telephony-adapter, shift-routing, conversation-routing, note-encryption, audit-chain (all tagged `@backend`)
- **6 integration test stubs** in `apps/worker/__tests__/integration/` (DO tests, require miniflare)
- **CI updated**: `worker-tests` job in `.github/workflows/ci.yml`
- **Vitest configs**: `vitest.unit.config.ts` + `vitest.integration.config.ts` at project root
- **playwright.config.ts**: added `and not @backend` to tag filter
- Commits: `63468ec`, `fca9025` (path fix)

### Epic 234: iOS BDD Test Expansion — BLOCKED
- Requires macOS with Xcode — cannot execute from Linux
- Documented as pending in NEXT_BACKLOG.md

## 2026-03-02: Android UI Polish — Search, String Extraction, BDD Expansion

### Search Features
- **CallHistoryScreen**: Exposed existing ViewModel search support in UI with `OutlinedTextField` search bar
- **ContactsScreen**: Added search capability — new `searchQuery` state in `ContactsViewModel`, API search parameter, search bar UI

### String Resource Extraction (i18n Readiness)
- Extracted 20+ hardcoded English strings to `strings.xml` across 15 files
- Categories: search placeholders, empty states (admin tabs), settings descriptions, logout dialog, note badges, device link steps, "Save" buttons
- Files updated: ConversationsScreen, DashboardScreen, ContactsScreen, OfflineBanner, SettingsScreen, DeviceLinkScreen, VolunteersTab, ShiftScheduleTab, BanListTab, CustomFieldsTab, AuditLogTab, InviteDialog, NotesScreen, NoteDetailScreen

### BDD Coverage Expansion
- **call-history.feature**: 6 → 10 scenarios (added: content/empty state, filter reset, pull-to-refresh, search field, back-to-dashboard)
- **report-list.feature**: 6 → 10 scenarios (added: content/empty state, closed filter, filter reset, pull-to-refresh, back-to-dashboard)
- **contacts-list.feature**: 3 → 8 scenarios (added: content/empty state, pull-to-refresh, dashboard card, search field, identifiers, back-to-dashboard)
- Total: 15 → 28 new scenarios; overall 250/250 Android (100%), 288/288 Desktop (100%)

## 2026-03-02: Android Feature Expansion — Call History, Reports, Contacts

### New Screens (Desktop Parity)
- **Call History**: `CallHistoryScreen.kt` + `CallHistoryViewModel.kt` — paginated call records with status filter chips (All/Completed/Unanswered), duration display, metadata badges (voicemail/transcription/recording), infinite scroll, pull-to-refresh
- **Reports**: `ReportsScreen.kt` + `ReportsViewModel.kt` — structured incident reports with status filter chips (All/Active/Waiting/Closed), category filtering, report cards with status dots, message counts, timestamps
- **Contacts**: `ContactsScreen.kt` + `ContactsViewModel.kt` — paginated contact summaries with aggregated interaction counts (calls/conversations/notes), hashed identifiers with admin-only last-4 display, first/last seen timestamps

### Data Models
- `CallModels.kt` — CallRecord, ActiveCall, CallHistoryResponse, CallCountResponse (matching desktop TypeScript interfaces)
- `ReportModels.kt` — Report, ReportMetadata, ReportsListResponse, ReportCategoriesResponse
- `ContactModels.kt` — ContactSummary, ContactsListResponse

### Navigation & Dashboard
- Added 3 navigation routes: `CallHistory`, `Reports`, `Contacts` (standalone screens with back navigation)
- Dashboard now shows "View Call History" link on Active Calls card, plus Reports and Contacts cards with navigation buttons
- All 3 screens accessible from Dashboard → standalone route → back to dashboard

### BDD Coverage
- 3 new feature files: `call-history.feature` (6 scenarios), `report-list.feature` (6 scenarios), `contacts-list.feature` (3 scenarios)
- 3 new step definition files: `CallHistorySteps.kt`, `ReportListSteps.kt`, `ContactsListSteps.kt`
- Coverage: 237/237 Android (100%), build + lint passing

## 2026-03-02: Android Brand Alignment & UI Polish

### Brand Alignment
- Rewrote `Color.kt` from terracotta (#C75B39) to teal (#006A6A) Material 3 palette — now matches logo (#51AFAE), desktop, and marketing site
- Rewrote `colors.xml` to match Kotlin palette (primary, secondary, tertiary, error, background, surface, logo brand colors)
- Updated `ic_launcher_background.xml` from terracotta to teal
- Created `logo_mark.xml` vector drawable — converted from `public/logo.svg` (7 paths, 4 colors, 560x660 viewport)

### Theme Enhancements
- Created `Shape.kt` with custom `LlamenosShapes` — 12dp small (buttons), 16dp medium (cards), 20dp large (FABs), 28dp extraLarge (sheets)
- Wired shapes into `Theme.kt` for app-wide consistent rounded corners

### Auth Screen Polish
- **LoginScreen**: Full redesign — logo image, staggered entrance animations (fadeIn + slideInVertically), card-wrapped form, "or" divider, icon+text buttons, side-by-side demo buttons
- **PINSetScreen**: Added logo, staggered entrance animations, scrollable layout
- **PINUnlockScreen**: Added logo, staggered entrance animations, Fingerprint icon on biometric button, TextButton for reset identity
- **OnboardingScreen**: Added logo, staggered entrance animations, card-wrapped key displays (npub in surfaceVariant card, nsec in semi-transparent errorContainer card), CheckCircle icon on confirm button

### BDD Coverage Validation
- Achieved 100% BDD coverage: 222/222 Android, 260/260 Desktop
- Fixed `validate-coverage.ts` Cucumber escape handling (`\/`, `\(`, `\)`)
- Added 4 step aliases in `GenericSteps.kt` for phrasing variant coverage

## 2026-03-02: Android Settings Polish & Admin Expansion (Epics 229-230)

### Epic 229: Android Admin Panel Expansion
- Created `ShiftScheduleTab.kt` — admin shift CRUD with list, create/edit/delete dialogs, testTags for all interactions
- Expanded `ConversationsScreen.kt` with search bar (`conversation-search-input`)
- Added conversation detail actions: assign volunteer, close/reopen conversation
- Extended `ConversationsViewModel.kt` with search, assign, close/reopen methods
- Admin panel now has 6 tabs: VOLUNTEERS, BANS, AUDIT, INVITES, FIELDS, SHIFTS (all functional)
- Updated `ShiftSteps.kt` with real UI interactions (shift-name-input, shift-start/end-input, create-shift-fab)
- RoleSteps remain API-level stubs (RBAC role CRUD is server-side, volunteer cards show role badges)
- Verified: `assembleDebugAndroidTest` → BUILD SUCCESSFUL

### Epic 230: Android Settings & Polish
- Rewrote `SettingsScreen.kt` with collapsible sections (SettingsSection composable + AnimatedVisibility)
  - Profile section: display name input, phone input, npub display with copy, update button
  - Theme section: light/dark/system ThemeButton composables
  - Hub Connection section (collapsible): URL + connection status indicator
  - Advanced Settings section (collapsible): placeholder for desktop-only config
- Updated `MainScreen.kt` call site: passes displayName, phone, selectedTheme from KeystoreService, onUpdateProfile/onThemeChange callbacks
- Created `BlastsScreen.kt` + `BlastsViewModel.kt`: full blast messaging UI with list, create dialog, individual/select-all recipient checkboxes, schedule toggle
- Added demo mode to `LoginScreen.kt`: demo-admin-button, demo-volunteer-button with onDemoLogin callback
- Created `DemoBanner.kt` component: dismissible tertiary container banner
- Added 30+ string resources (settings, blasts, demo mode, panic wipe)
- Replaced ALL remaining BDD step stubs with real Compose UI interactions:
  - `ProfileSettingsSteps.kt`: profile editing, section toggling, theme picker
  - `BlastSteps.kt`: create blast, recipient selection, schedule toggle
  - `DemoModeSteps.kt`: demo login buttons, banner dismiss, nav assertions
  - `PanicWipeSteps.kt`: hardware key simulation via `Instrumentation.sendKeyDownUpSync(KEYCODE_VOLUME_DOWN)`
  - `ReportSteps.kt`: mapped to note creation flow (create-note-fab, note-text-input, save-note-button)
  - `GenericSteps.kt`: audit filter/search assertions
  - `VolunteerSteps.kt`: nsec import, profile setup, nsec display
- Verified: `assembleDebugAndroidTest` + `lintDebug` + `testDebugUnitTest` → ALL BUILD SUCCESSFUL

## 2026-03-02: Android BDD Step Definitions (Epic 228)

### Epic 228: Android BDD Step Definitions for Full Feature Coverage
- Extended from 189 → 498 step definitions across 14 → 26 step classes
- Created 12 new step files: GenericSteps, BanSteps, InviteSteps, ReportSteps, RoleSteps, DemoModeSteps, VolunteerSteps, PanicWipeSteps, BlastSteps, CustomFieldSteps, ProfileSettingsSteps, messaging/BlastSteps
- Modified 7 existing files: BaseSteps (navigateToAdminTab, hasTestTagPrefix), NavigationSteps (admin nav, logout), AdminSteps (audit log), ConversationSteps (9→28 steps), ShiftSteps (9→30 steps), PinSteps (dedup confirmation dialog)
- Key patterns: hasTestTagPrefix() semantic matcher for dynamic testTags, navigateToAdminTab() Settings→Admin→Tab routing, GenericSteps shared click/fill/assert/dialog
- All @android feature file scenarios now have matching step definitions
- Stubs for unbuilt UI deferred to Epics 229 (admin) and 230 (settings/polish)
- Verified: `assembleDebugAndroidTest` + `lintDebug` → BUILD SUCCESSFUL

## 2026-03-01: Cross-Platform BDD E2E Test Suite (Epics 218-222)

### Epic 218: Cross-Platform BDD Test Framework
- Created `packages/test-specs/` workspace with `package.json`, `README.md`, Gherkin conventions
- Created `packages/test-specs/tools/validate-coverage.ts` — CI validation script that parses `.feature` files, extracts scenario titles, converts to camelCase, and matches against Android `@Test` methods
- Added `"test-specs:validate"` script to root `package.json`
- Created `helpers/TestNavigationHelper.kt` — shared `navigateToMainScreen()` (create identity → confirm backup → PIN 1234 → dashboard) and `navigateToTab()` helpers
- Created `helpers/ComposeTestExtensions.kt` — `ComposeRule` typealias, `assertTagDisplayed()`, `clickTag()`, `scrollToAndAssertTag()`, `assertAnyTagDisplayed()` (loading/empty/list pattern), `enterPin()` helper

### Epic 219: Auth Flow BDD Specs (24 scenarios → 5 feature files, 5 test classes)
- Feature files: `login.feature` (6), `onboarding.feature` (4), `pin-setup.feature` (6), `pin-unlock.feature` (5), `key-import.feature` (3)
- Test classes: `LoginScreenTest`, `OnboardingFlowTest`, `PinSetupTest`, `PinUnlockTest` (with `@Inject CryptoService/KeystoreService`, `StoredKeyData` state setup, `@After` teardown), `KeyImportTest`
- Deleted old `AuthFlowTest.kt`

### Epic 220: Core Features BDD Specs (34 scenarios → 10 feature files, 11 test classes)
- Dashboard: `dashboard-display.feature` (8), `shift-status.feature` (2) → `DashboardDisplayTest` (8), `DashboardShiftActionsTest` (2)
- Notes: `note-list.feature` (3), `note-create.feature` (3), `note-detail.feature` (3) → `NoteListTest` (3), `NoteCreateTest` (3), `NoteDetailTest` (3)
- Conversations: `conversation-list.feature` (3), `conversation-filters.feature` (4) → `ConversationListTest` (3), `ConversationFiltersTest` (4)
- Shifts: `shift-list.feature` (3), `clock-in-out.feature` (2) → `ShiftListTest` (3), `ClockInOutTest` (2)
- Navigation: `bottom-navigation.feature` (3) → `BottomNavigationTest` (3)
- Deleted old `NoteFlowTest.kt`, `ShiftFlowTest.kt`, `ConversationFlowTest.kt`

### Epic 221: Admin, Settings & Access Control BDD Specs (27 scenarios → 6 feature files, 6 test classes)
- Settings: `settings-display.feature` (6), `lock-logout.feature` (4), `device-link.feature` (6) → `SettingsDisplayTest` (6), `LockLogoutTest` (4 with `@After` teardown), `DeviceLinkTest` (6)
- Admin: `admin-navigation.feature` (2), `admin-tabs.feature` (6 with Scenario Outline), `access-control.feature` (3) → `AdminNavigationTest` (2), `AdminTabsTest` (6), `AccessControlTest` (3 with CryptoService/KeystoreService injection)
- Deleted old `AdminFlowTest.kt`

### Epic 222: Crypto Interop E2E Verification (21 scenarios → 4 feature files, 5 test classes)
- Feature files: `keypair-generation.feature` (4), `pin-encryption.feature` (6 with Scenario Outline), `auth-tokens.feature` (3), `crypto-interop.feature` (8)
- Created `TestVectors.kt` — data classes for `test-vectors.json` deserialization (KeyVectors, PinEncryptionVectors, AuthVectors, NoteEncryptionVectors, MessageEncryptionVectors)
- Test classes: `KeypairGenerationTest` (4), `PinEncryptionTest` (6), `AuthTokenTest` (3), `CryptoInteropTest` (8 loading from `androidTest/assets/test-vectors.json`)
- Added Gradle `copyTestVectors` task to sync `test-vectors.json` from `packages/crypto/tests/fixtures/` on `preBuild`

### Infrastructure Changes
- Added `hilt-android-testing` to `gradle/libs.versions.toml` (was using `hilt-android` which lacks `@HiltAndroidTest` annotation processor)
- Updated `build.gradle.kts`: `androidTestImplementation(libs.hilt.android.testing)` replacing `androidTestImplementation(libs.hilt.android)`
- Organized 26 test files across 9 directories: `auth/`, `dashboard/`, `notes/`, `conversations/`, `shifts/`, `navigation/`, `settings/`, `admin/`, `crypto/`

### Verification
- `assembleDebugAndroidTest`: BUILD SUCCESSFUL (106 @Test methods compile)
- `lintDebug`: BUILD SUCCESSFUL
- `test-specs:validate`: 102/102 scenarios covered (100%), 106 @Test methods mapped

## 2026-03-01: Playwright Test Restoration (Epic 216)

### Epic 216: Restore All Playwright E2E Tests on Desktop Branch
- **Result**: 361 passed, 5 skipped (live telephony), 0 failed
- **Tauri IPC mock fixes** (`tests/mocks/tauri-core.ts`):
  - Fixed PIN encryption: correct PBKDF2 iteration count (600k), encrypt nsec bech32 string (not raw hex)
  - Fixed @noble/curves v2: pass Uint8Array to `schnorr.sign()`/`schnorr.getPublicKey()` (not hex strings)
  - Fixed auth token format: return JSON `{ pubkey, timestamp, token }` with `AUTH_PREFIX` in signed message
  - Added `noteKeyStore` Map for within-page note encryption round-trip (replacing static mock response)
- **PinInput stale closure fix** (`src/client/components/pin-input.tsx`):
  - `handleInput()` had a stale closure bug — rapid sequential keyboard input caused data loss because each call read `digits` from the render scope before React re-rendered
  - Fixed with `valueRef` that's updated optimistically in the handler
- **Test selector fixes** (strict mode violations):
  - Added `data-testid="field-type-select"` / `data-testid="field-context-select"` to custom-fields-section.tsx
  - Changed `getByRole('link', { name: /settings/i })` → `{ name: 'Settings', exact: true }`
  - Changed `getByRole('heading', { name: /conversations/i })` → `page.locator('h1', ...)`
  - Changed `#new-field-priority_level` → `page.getByLabel('Priority Level')` (field IDs are UUIDs)
- **Test isolation fixes**:
  - Made notes-custom-fields tests self-contained (each creates own prerequisites)
  - Added `Date.now()` suffix to volunteer names in messaging-epics tests
  - Added `option.waitFor()` before click in shift-management combobox test
- **Config**: `workers: 3` for parallel execution

## 2026-03-01: Android UniFFI Crypto Integration (Epic 214)

### Epic 214: Mobile Crypto Integration (Android)
- **Fixed build-mobile.sh**: Updated `cargo ndk` flag from `-p 24` (v3 syntax) to `--platform 24` (v4 syntax) for cargo-ndk 4.1.2 compatibility
- **Built native .so files**: 4 ABIs (arm64-v8a: 584K, armeabi-v7a: 400K, x86: 692K, x86_64: 688K) via `packages/crypto/scripts/build-mobile.sh android`
- **Copied UniFFI Kotlin bindings**: `packages/crypto/bindings/kotlin/org/llamenos/core/llamenos_core.kt` (2034 lines, JNA-based) → `apps/android/app/src/main/java/org/llamenos/core/`
- **Added JNA dependency**: `net.java.dev.jna:jna:5.17.0@aar` to version catalog + build.gradle.kts
- **Rewrote CryptoService.kt**: All 13 crypto methods now call real FFI when native lib loaded:
  - `generateKeypair()` → `org.llamenos.core.generateKeypair()` (real secp256k1)
  - `importNsec()` → `org.llamenos.core.keypairFromNsec()` (real bech32 decode)
  - `encryptForStorage()` → `org.llamenos.core.encryptWithPin()` (real PBKDF2 + XChaCha20-Poly1305)
  - `decryptFromStorage()` → `org.llamenos.core.decryptWithPin()` + `keypairFromNsec()`
  - `createAuthToken()` → `org.llamenos.core.createAuthToken()` (real BIP-340 Schnorr)
  - `encryptNote()` → `org.llamenos.core.encryptNoteForRecipients()` (real per-note ECIES)
  - `decryptNote()` → `org.llamenos.core.decryptNote()` (real ECIES unwrap + XChaCha20)
  - `encryptMessage()` → `org.llamenos.core.encryptMessageForReaders()` (real per-message ECIES)
  - `decryptMessage()` → `org.llamenos.core.decryptMessageForReader()` (real ECIES unwrap)
  - `generateEphemeralKeypair()` → `org.llamenos.core.generateKeypair()` (real secp256k1)
  - `deriveSharedSecret()` / `decryptWithSharedSecret()` / `deriveSASCode()` — placeholder kept (FFI functions not yet exported for device linking ECDH)
- **Added nsecBech32 storage**: CryptoService now stores the bech32 nsec string alongside hex (needed for PIN encryption which encrypts the bech32 form)
- **Updated NoteEnvelope**: Added `ephemeralPubkey` field (was missing in placeholder), updated NotesViewModel to pass real ephemeral pubkeys instead of placeholder
- **Updated EncryptedKeyData**: Added `iterations` field (UInt, default 600_000) for PBKDF2 iteration count round-tripping
- **Updated StoredKeyData**: Added `iterations` field with default value for backward compatibility
- **Updated proguard-rules.pro**: Added `org.llamenos.core.**` and JNA keep rules, replaced old `uniffi.llamenos_core.**` reference
- **Updated .gitignore**: Added `apps/android/app/src/main/jniLibs/` (binary .so files not committed)
- **Verification**: `./gradlew assembleDebug` ✓, `./gradlew testDebugUnitTest` (all tests pass) ✓, `./gradlew lintDebug` ✓
- **iOS**: Awaiting macOS for XCFramework build — `#if canImport(LlamenosCore)` guards already in place

## 2026-03-01: Mobile Feature Parity & Release Prep (Epics 208-210)

### Epic 208: Feature Parity Phase 1
- iOS & Android: Notes with E2EE (per-note forward secrecy, ECIES key wrapping)
- iOS & Android: Shifts with clock in/out, weekly schedule, signup/drop
- iOS & Android: Push notification encryption (two-tier wake key)
- iOS & Android: Tab-based navigation (Dashboard, Notes, Shifts, Settings)
- iOS & Android: WebSocket real-time events via WebSocket relay
- iOS & Android: Settings screens (identity, hub, connection, lock/logout)
- UI tests: 7 note flow + 10 shift flow tests per platform

### Epic 209: Feature Parity Phase 2
- iOS & Android: E2EE conversations (SMS/WhatsApp/Signal channels)
- iOS & Android: Admin panel (volunteers CRUD, ban list, audit log, invites)
- iOS & Android: QR-based device linking with ECDH + SAS verification
- iOS: CameraX QR scanning via AVCaptureSession
- Android: CameraX + ML Kit barcode scanning
- iOS & Android: Enhanced settings (notifications, language, auto-lock, biometric)
- UI tests: 6 conversation + 6 admin tests per platform

### Epic 210: Release Prep
- Android: Release signing config (env-var keystore, ProGuard rules)
- iOS: Info.plist with version tracking, capabilities, usage descriptions
- CI/CD: `mobile-release.yml` workflow (build + sign + upload to TestFlight/Play Store)
- CI/CD: Version bump in `ci.yml` now includes Android `build.gradle.kts` + iOS `Info.plist`
- Version sync: `bump-version.ts` updated for Android versionName/versionCode + iOS CFBundleShortVersionString/CFBundleVersion
- Documentation: CLAUDE.md updated with mobile build/release commands

## 2026-03-01: Monorepo Foundation & Multi-Platform (Epics 200-207)

### Epic 200: Monorepo Foundation
- Moved `src-tauri/` → `apps/desktop/`, `src/worker/` → `apps/worker/`, `src/shared/` → `packages/shared/`
- Converted worker relative imports to `@shared/` alias (65+ files)
- Updated all configs: `tsconfig.json`, `vite.config.ts`, `tauri.conf.json`, `wrangler.jsonc`, CI workflows
- Added `workspaces` to root `package.json`

### Epic 201: Absorb llamenos-core
- Used `git subtree add` to absorb `llamenos-core` into `packages/crypto/`
- Updated `apps/desktop/Cargo.toml` path dep → `../../packages/crypto`
- Removed CI workarounds and cross-repo dispatch triggers

### Epic 202: Protocol Schema & Codegen
- Created `packages/protocol/` with 8 JSON Schema files (envelope, notes, files, telephony, messaging, channels, blasts, hub)
- Built `tools/codegen.ts` using quicktype-core → generates TypeScript interfaces, Swift structs, Kotlin data classes
- Created `crypto-labels.json` with all 28 domain separation constants
- Added `bun run codegen` / `bun run codegen:check` scripts

### Epic 203: Workers Restructuring
- Created `apps/worker/package.json` and `apps/worker/tsconfig.json`
- Moved `wrangler.jsonc` → `apps/worker/wrangler.jsonc`
- Updated root scripts to use `--config apps/worker/wrangler.jsonc`

### Epic 204: CI/CD Consolidation
- Added `crypto-tests` job to `ci.yml` (cargo test + clippy + fmt)
- Added `ci-status` gate job aggregating all CI jobs
- Updated version job to depend on crypto-tests

### Epic 205: i18n Package Extraction
- Created `packages/i18n/` with locale files, `languages.ts`, and `index.ts`
- Built `tools/i18n-codegen.ts` → iOS `.lproj/Localizable.strings` + Android `values-*/strings.xml`
- Added `bun run i18n:codegen` / `bun run i18n:validate` scripts
- Added `@llamenos/i18n` path alias

### Epic 206: iOS Client Foundation
- Created `apps/ios/` with SwiftUI app (iOS 17+, `@Observable`, SPM)
- Services: CryptoService (UniFFI wrapper with stand-in mock), KeychainService, APIService, AuthService
- Views: LoginView, OnboardingView, PINSetView, PINUnlockView, DashboardView
- Components: PINPadView, SecureTextField, LoadingOverlay
- ViewModels: AuthViewModel, PINViewModel, DashboardViewModel
- App lifecycle: scenePhase-based lock after 5 min background

### Epic 207: Android Client Foundation
- Created `apps/android/` with Kotlin/Compose app (minSdk 26, Material 3, Hilt DI)
- Gradle version catalog with centralized dependencies
- Services: CryptoService (JNI placeholder), KeystoreService (EncryptedSharedPreferences), ApiService + AuthInterceptor
- UI: Navigation, Theme, LoginScreen, OnboardingScreen, PINSetScreen, PINUnlockScreen, DashboardScreen
- Components: PINPad, SecureText, LoadingOverlay
- Hilt DI module, FCM PushService stub

## 2026-02-27: Mobile Records Architecture (Epics 125-128)

### Epic 125: Mobile Note Threading
- Updated mobile `types.ts` to match desktop records architecture (EncryptedNote, ConversationMessage, CustomFieldDefinition, Conversation)
- Added `ContactSummary`, `CustomFieldContext`, `fieldMatchesContext()` types
- Added API client methods: `listNoteReplies`, `createNoteReply`, `listContacts`, `getContactTimeline`
- Rewrote NoteCard with optional callId, reply button, conversation badge
- Rewrote MessageBubble to use `readerEnvelopes` instead of `adminEnvelopes`
- Added thread expansion/collapse and encrypted reply sending to notes list and detail screens
- Fixed cascading type errors in admin settings custom field form

### Epic 126: Mobile Contacts Page
- Created admin-only contacts list with paginated FlatList and pull-to-refresh
- Created contact timeline detail with decrypted notes (V2/V1 fallback) and conversation metadata
- Added contacts and contact/[hash] routes to admin stack navigator
- Added contacts admin link in settings screen

### Epic 127: Mobile Conversation Notes
- Created NoteFormModal component with context-filtered custom fields and E2EE encryption
- Created CustomFieldInputs component rendering text, textarea, number, checkbox, and select fields
- Integrated "Add Note" header button into conversation thread screen
- Field filtering via `fieldMatchesContext()` for call-notes vs conversation-notes context

### Epic 128: Mobile Records i18n & Detox Tests
- Added note threading, contacts, conversations, and custom field context translation keys to all 13 locale files
- Created 4 Detox E2E test files: note-threading, contacts, conversation-notes, custom-field-context
- Updated test-ids.ts with 10 new testID constants
- All translations: en, es, zh, tl, vi, ar, fr, ht, ko, ru, hi, pt, de

## 2026-02-27: Unified Records Architecture (Epics 119-124)

### Epic 119: Records Domain Consolidation
- Fixed CRITICAL report type filtering bug — reports list was including non-report conversations
- Extracted shared ConversationThread component used by conversations, reports, and note threads
- Extracted BlastDO from RecordsDO for cleaner separation of concerns
- Migrated to per-record conversation storage keys in ConversationDO

### Epic 120: Unified Envelope Types
- Consolidated `KeyEnvelope` and `MessageEnvelope` into single `RecipientEnvelope` type
- Standardized naming across notes, messages, and call records
- Updated all crypto functions, API endpoints, and components

### Epic 121: Custom Fields Generalization
- Extended custom fields beyond call notes to reports and conversation notes
- Added `context` field (call-notes, conversation-notes, reports, all)
- Shared `CustomFieldInputs` and validation components
- Custom fields visible in report forms and conversation note sheets

### Epic 122: Conversation Storage Scaling
- Per-record storage keys in ConversationDO (conversation data in `conv:${id}:*`)
- BlastDO extracted as standalone Durable Object
- Pagination support for conversation and message listing
- Auto-migration from legacy flat storage on first access

### Epic 123: Conversation Notes & Contact View
- Note threading with encrypted replies using ECIES envelope pattern
- Conversation notes — attach E2EE notes to conversations from the detail view
- Contact unified timeline — admin page showing all interactions per contact
- Contact-level permissions (`contacts:view`, `contacts:view-history`)
- Note reply API with `notes:reply` permission
- i18n translations for all new strings across 13 languages

### Epic 124: Records E2E Tests
- Report isolation tests (reports vs conversations type filtering)
- Custom fields context tests (call-notes, conversation-notes, reports)
- Threaded notes tests (create, reply, conversation notes)
- Contact view tests (admin-only access, unified timeline)

## 2026-02-27: CI Hardening, Test Vectors, Docs & Quality (Epics 111-118)

### Epic 111: CI Security Hardening
- Pinned all GitHub Actions to SHA hashes across all 3 repos
- Standardized Bun version to 1.3.5 in all 8 workflows
- Added PR triggers to llamenos ci.yml
- Added dependabot.yml to all 3 repos (GitHub Actions ecosystem only)
- Fixed silent failures (CocoaPods continue-on-error, native lib download warnings)

### Epic 112: Comprehensive Crypto Test Vectors
- Expanded from 6 to 14 crypto operation categories in test vectors v2
- **Critical fix**: BIP-340 Schnorr double-hashing bug — k256 `Signer::sign()` internally SHA-256 hashes, causing double-hash when combined with pre-hashing. Switched to `PrehashSigner::sign_prehash()` / `PrehashVerifier::verify_prehash()`
- 24 JS interop tests consuming Rust vectors (up from 8)
- Fixed all @noble/* v2 API breaking changes (sha2.js, separate schnorr export, Uint8Array inputs, HKDF salt/info types)

### Epic 113: Mobile Crypto Interop Validation
- 23 Jest unit tests in llamenos-mobile validating JS crypto against Rust vectors
- jest.config.unit.js with @noble/* ESM transform handling
- Unit test step added to mobile-e2e.yml CI (before Detox for faster feedback)

### Epic 114: Docs Site — Mobile Content & Missing Pages
- `architecture.md` — Three-repo diagram, data flow, encryption matrix, key hierarchy
- `mobile-guide.md` — Download, provisioning, feature comparison, limitations
- `troubleshooting.md` — Docker, Cloudflare, desktop, mobile, telephony, crypto errors
- Updated sidebar with new sections, download page mobile card links to guide

### Epic 115: Docs Site — i18n Completion
- 132 new translation files: 21 docs + 2 pages × 12 languages (zh, tl, vi, ar, fr, ht, ko, ru, hi, pt, de, es)
- Docs: deploy-docker, deploy-kubernetes, self-hosting, reporter-guide, setup-signal, setup-sms, setup-whatsapp, architecture, mobile-guide, troubleshooting + 11 pre-existing docs
- Pages: features, security (marketing site pages with full content)
- Site builds cleanly: 338 pages rendered across all languages
- API reference kept English-only (technical reference for developers)

### Epic 116: Cross-Repo CI Integration
- llamenos-core CI dispatches `core-updated` event to llamenos + llamenos-mobile on main push
- Both downstream repos accept `repository_dispatch` trigger
- CROSS_REPO_TOKEN setup documented in HUMAN_INSTRUCTIONS.md

### Epic 117: Adversarial Crypto Tests
- 10 new Rust adversarial tests: truncated data, tampered ciphertext, invalid keys, wrong recipients
- 7 JS adversarial interop tests consuming adversarial vectors
- Total: 45 Rust tests (34 unit + 11 interop), 24 JS interop tests

### Epic 118: Docs Site — API Reference & Changelog
- 1680-line API reference covering all 6 DO domains, 22+ endpoint groups
- Permission reference with 13 domains and 76+ permissions
- CHANGELOG.md cleanup and milestone summary

## 2026-02-27: Multi-Platform Completion & Release Readiness (Epics 100-110)

### Epic 100: llamenos-core Native Build for Mobile
- `scripts/build-mobile.sh` — builds Android .so (4 arch via cargo-ndk) and iOS .a (device + sim → XCFramework), generates UniFFI Swift/Kotlin bindings
- `rust-toolchain.toml` — pins stable toolchain with all 11 targets (desktop, mobile, WASM)
- `.github/workflows/release.yml` — added `build-mobile-android` and `build-mobile-ios` jobs, release artifacts

### Epic 101: Mobile Native Module Integration
- `modules/llamenos-core/ios/LlamenosCore.podspec` — CocoaPods podspec for vendored XCFramework
- `scripts/download-core-libs.sh` — downloads pre-built native libs from GitHub Releases
- `.gitignore` updated for native lib directories

### Epic 102: Mobile Static Build Pipeline
- `.github/workflows/mobile-build.yml` — APK + iOS simulator .app builds on tags
- `eas.json` — preview (APK + simulator) and production profiles

### Epic 103: Mobile App Feature Completion
- All 5 admin settings sections implemented: Telephony, Spam, Calls, Custom Fields, Roles
- 14+ API client methods added for settings CRUD, custom fields, roles, volunteer management
- Volunteer delete/invite/add APIs wired to backend

### Epic 104: Mobile E2E Test Expansion
- 6 new Detox test files: conversations, settings, admin-settings, admin-volunteers, navigation, error-states
- Expanded auth.test.ts (PIN retry, nsec import) and notes.test.ts (detail view, pagination)
- testID additions across admin settings, volunteers, offline banner
- CI fixes: applesimutils install, CocoaPods caching, headless emulator flags

### Epic 105: Cross-Platform Crypto Verification
- `tests/interop.rs` — 5 test suites generating deterministic test vectors (JSON fixtures)
- `tests/crypto-interop.spec.ts` — Playwright tests consuming Rust-generated vectors
- Synced Rust labels with TypeScript (added LABEL_PUSH_WAKE, LABEL_PUSH_FULL → 28 labels)

### Epic 106: Mobile UX Refinements
- Deep linking config (`llamenos://` scheme) for iOS and Android
- KeyboardDismissWrapper for tap-to-dismiss across all screens
- Skeleton loaders: DashboardSkeleton, SkeletonLoader, audit screen
- Accessibility: roles, labels, hints on login, onboarding, admin screens
- Pull-to-refresh with haptic feedback and themed tint color

### Epic 107: Multi-Platform Security Hardening
- `src/lib/security-checks.ts` — advisory jailbreak/root detection (warns, doesn't block)
- HTTPS transport enforcement in mobile API client
- expo-device for emulator detection

### Epic 108: Version Sync & Developer Tooling
- Rewrote `scripts/bump-version.ts` to sync all 5 version files
- `scripts/sync-versions.sh` — checks/fixes version mismatches across repos
- `scripts/dev-setup.sh` — developer environment bootstrapping (all three repos)

### Epic 109: Desktop Polish & Release Prep
- Version synced to 0.18.0 across tauri.conf.json and Cargo.toml
- Enhanced tray menu: Show/Hide toggle, Check for Updates, About with version, separators, double-click handler

### Epic 110: Documentation & Guides
- `CONTRIBUTING.md` — coding standards, adding crypto ops, adding API endpoints, E2E tests
- `docs/ARCHITECTURE.md` — three-repo structure, data flow, encryption, DOs, security layers
- `docs/DESKTOP_BUILD.md` — prerequisites, dev/release builds, Flatpak, troubleshooting
- `docs/MOBILE_BUILD.md` (in llamenos-mobile) — prerequisites, dev, APK/iOS builds, Detox
- `docs/HUMAN_INSTRUCTIONS.md` — added sections 9-12: Google Play, Apple Developer, F-Droid, Push Notifications

## 2026-02-26: Release Pipeline & Distribution (`desktop` branch)

### Epic 99: Human Setup Guide (HUMAN_INSTRUCTIONS.md)

Comprehensive operator guide at `docs/HUMAN_INSTRUCTIONS.md` (~730 lines):
- **Tauri updater signing**: Keypair generation, GitHub secrets setup
- **Apple Developer Account**: Certificate export, notarization, App-Specific Password
- **Windows code signing**: Azure Trusted Signing setup (recommended over EV hardware tokens)
- **Flathub submission**: Fork, manifest, PR workflow
- **Future mobile**: F-Droid and Google Play Store placeholders
- **GitHub secrets checklist**: Complete table of all 13 secrets across all workflows
- **Version sync checklist**: Pre-release verification steps

### Epic 98: Download Experience

Marketing site download page with OS auto-detection:
- **`site/src/pages/download.astro`** + **`[lang]/download.astro`**: Platform detection via `navigator.userAgent`, 6 download cards (Windows, macOS, Linux AppImage/deb/Flatpak, Mobile coming soon), client-side `latest.json` fetch for download URLs
- **`site/src/i18n/translations/download.ts`**: Full i18n for en, es, zh (other langs fall back to English)
- **Header.astro**: Added Download to nav items
- **HomeContent.astro**: Hero CTA → `/download`, secondary → `/docs/getting-started`
- **common.ts**: Added `download` nav key across all 13 languages
- **home.ts**: Hero CTA text "Get started" → "Download" (13 langs), "Mobile-first PWA" → "Desktop app" (13 langs)
- Site builds 286 pages successfully

### Epic 97: Desktop Release Pipeline

Activated and extended `tauri-release.yml` for automated desktop distribution:
- **Trigger**: Changed from `release/desktop-v*` to `v*` tags (same as docker.yml)
- **Version sync step**: Extracts version from tag, updates `tauri.conf.json` + `package.json` before build
- **Flatpak job**: `flatpak/flatpak-github-actions/flatpak-builder@v6` with `org.gnome.Platform` v47
- **Flatpak manifest**: `flatpak/org.llamenos.Hotline.yml` + `.desktop` + `.metainfo.xml`
- **Updater feature flag**: `src-tauri/Cargo.toml` makes `tauri-plugin-updater` optional; Flatpak builds with `--no-default-features --features custom-protocol`
- **Conditional compilation**: `src-tauri/src/lib.rs` uses `#[cfg(feature = "updater")]` for updater plugin
- **Release dedup**: Checks if GitHub Release exists (from ci.yml), uploads artifacts to it or creates new

### Epic 96: llamenos-core CI/CD Pipeline

Added CI/CD to the `llamenos-core` repo:
- **`.github/workflows/ci.yml`**: Runs on every push to main + PRs — `cargo test --all-features`, `cargo clippy -- -D warnings`, WASM build validation, UniFFI build validation
- **`.github/workflows/release.yml`**: On `v*` tags — builds native libraries for 4 targets (linux-x64, macos-x64, macos-arm64, windows-x64), WASM package via wasm-pack, UniFFI Swift+Kotlin bindings, creates GitHub Release with all artifacts
- **`scripts/bump-version.sh`**: Reads Cargo.toml version, bumps major/minor/patch, updates Cargo.toml+Cargo.lock, creates annotated git tag

## 2026-02-26: Multi-Platform Native Clients (`desktop` branch)

### Epic 95: Deployment Architecture for Desktop-Only

Updated deployment infrastructure for desktop-only architecture:
- **Dockerfile**: Removed frontend build stage (API-only). Added download landing page for browsers.
- **CI/CD**: Renamed `deploy-app` → `deploy-api`. Build step uses `PLAYWRIGHT_TEST=true` for E2E. Removed Vite build from deploy job.
- **Package.json scripts**: `dev` → `tauri dev`, `deploy:demo` → `deploy:api`, `build:docker` is API-only, added `dev:vite` for quick frontend iteration.
- **README.md**: Major rewrite — desktop-first installation, API-only deployment, updated architecture section, removed PWA/browser references.
- **Caddyfile**: Updated comment for API-only + download page routing.

### Epic 94: Build Cleanup, Test Infrastructure & Dead Code Removal

Complete Tauri-only build cleanup with Playwright test compatibility:
- **Tauri IPC mock layer**: `tests/mocks/` with `tauri-core.ts`, `tauri-store.ts`, `tauri-ipc-handler.ts`, `crypto-impl.ts`, `key-store-impl.ts`. Vite aliases activated by `PLAYWRIGHT_TEST=true` env var.
- **Dead file removal**: Deleted `crypto.ts` (moved to test mock), `key-store.ts`, `sri-workbox-plugin.ts`, `pwa-install-banner.tsx`, `use-pwa-install.ts`, `notification-pwa.spec.ts`.
- **Vite config simplification**: Removed `VitePWA`, `sriWorkboxPlugin`, `isTauriDev` conditionals, `__TAURI__` define. Always `esnext` target.
- **panic-wipe.ts**: Removed service worker unregistration, added Tauri Store cleanup.
- **Package cleanup**: Removed `vite-plugin-pwa` dependency. Added `test:build` script.
- **Type relocation**: `KeyEnvelope`, `RecipientKeyEnvelope` moved from `crypto.ts` to `@shared/types.ts`.
- **CLAUDE.md updated**: Reflects Tauri-only architecture, mock test infrastructure, updated commands.
- Both production build and `PLAYWRIGHT_TEST=true` test build verified passing.

### Epic 93: Tauri-Only TypeScript Migration (e3aeabb)

Complete rewrite of TypeScript crypto plumbing — nsec never enters webview:
- **platform.ts**: Removed all `isBrowser()`/`isTauri()` branching. Every function is a direct `tauriInvoke`. Dropped `secretKeyHex` from ~12 stateful functions. Added `signWebSocketEvent`, `decryptFileMetadata`, `unwrapFileKey`, `unwrapHubKey`, `rewrapFileKey`, `getNsecFromState`, `isValidNsec` (async), `keyPairFromNsec`, `createAuthTokenStateless`, `verifySchnorr`.
- **key-manager.ts**: Deleted `secretKey: Uint8Array` closure, `getSecretKey()`, `getNsec()`, `createAuthToken()`. Tracks only `unlocked: boolean` + cached pubkey.
- **auth.tsx**: Uses `createAuthTokenStateless` for sign-in (pre-CryptoState flow).
- **api.ts**: `getAuthHeaders()` now async, uses `platform.createAuthToken()`.
- **file-crypto.ts**: ECIES ops → Rust IPC; symmetric file content crypto stays in JS.
- **hub-key-manager.ts**: `eciesWrapKey`/`unwrapKey` → platform.ts async IPC.
- **WebSocket/relay.ts**: Removed `getSecretKey`, `handleAuth` uses `signWebSocketEvent`.
- **WebSocket/events.ts**: `createHubEvent` uses `signWebSocketEvent` (no `secretKey` param).
- **WebSocket/context.tsx**: Removed `getSecretKey` prop from `WebSocketProvider`.
- **23 files changed**: 585 insertions, 639 deletions. All verified: zero `getSecretKey` in code, zero `isBrowser()`, zero `from '@/lib/key-store'`.

### Epic 92: Rust IPC Expansion (d419584)

Added ~15 new stateful IPC commands to `src-tauri/src/crypto.rs` delegating to `llamenos-core`. All Rust functions for Epic 93's TypeScript migration.

### Epic 81: Native Crypto Migration — Phases 1-5 (Platform Abstraction)

- **Phase 1: Platform Detection Layer** — `platform.ts` extended with all crypto operation wrappers: `encryptNote`, `decryptNote`, `decryptLegacyNote`, `encryptMessage`, `decryptMessage`, `decryptCallRecord`, `decryptTranscription`, `encryptDraft`, `decryptDraft`, `encryptExport`, `isValidNsec`. Each routes to Rust IPC on desktop, JS (`@noble/*`) on browser.
- **Phase 2-4: Key Manager + ECIES + Auth Token Migration** — `key-manager.ts` loads CryptoState on desktop via `platform.decryptWithPin`. All `createAuthToken` calls route through platform. `redeemInvite` API updated to accept `secretKeyHex` and use platform's `createAuthToken`.
- **Phase 5: Note/Message Encryption Migration** — All 15 files migrated from `@/lib/crypto` → `@/lib/platform`:
  - Routes: `index.tsx`, `notes.tsx`, `calls.tsx`, `conversations.tsx`, `reports.tsx`, `login.tsx`, `onboarding.tsx`, `volunteers.tsx`
  - Components: `note-sheet.tsx`, `ConversationThread.tsx`, `ReportForm.tsx`, `AdminBootstrap.tsx`
  - Lib: `use-draft.ts`, `api.ts`, `platform.ts`
  - Key API changes: sync → async (`await`), `Uint8Array` → hex string (`bytesToHex`), `encryptNoteV2` → `encryptNote(JSON.stringify(...))`, `decryptNoteV2` → `decryptNote` (returns JSON string), `generateKeyPair` returns `PlatformKeyPair` with `secretKeyHex`
- **Remaining**: Phases 6-7 (WASM build replacing `@noble/*` in browser, cross-platform test vectors) deferred to post-launch.

### Epic 80: Desktop Security Hardening (Tauri v2)

- **Phase 1: Tauri Isolation Pattern** — `src-tauri/isolation/index.html` sandboxed iframe with IPC command allowlist. All 21 crypto commands + plugin commands explicitly allowed. Unlisted commands rejected at the isolation layer before reaching Rust.
- **Phase 2: Stronghold PBKDF2-SHA256** — Replaced single SHA-256 hash with PBKDF2 (600K iterations) using domain-separated salt `llamenos:stronghold:v1`. Added `pbkdf2`, `hmac` crate dependencies.
- **Phase 3: CSP Hardening** — Added `form-action: 'none'`, `frame-ancestors: 'none'`. Tightened `connect-src` from `*.llamenos.org` wildcards + localhost to specific origins. `isolation:` added to `default-src` for the isolation iframe.
- **Phase 4: Capability Scoping** — Removed `fs:default` and `shell:default` entirely. Replaced `store:default` with specific `store:allow-get/set/delete/save/load`. Replaced `notification:default` with specific allow permissions. Added `process:allow-exit` only (no `process:default`).
- **Phase 5: Updater Infrastructure** — pubkey placeholder and GitHub Releases endpoint configured. `createUpdaterArtifacts: true` in bundle config.
- **Phase 6: CryptoState Memory Protection** — `CryptoState` struct in Rust with `Mutex<Option<String>>` for secret key and `zeroize` on lock. New stateful IPC commands: `unlock_with_pin`, `import_key_to_state`, `lock_crypto`, `is_crypto_unlocked`, `get_public_key_from_state`, `create_auth_token_from_state`, `ecies_unwrap_key_from_state`, `decrypt_note_from_state`, `decrypt_message_from_state`. Zeroization on window destroy and quit. `platform.ts` routes to stateful commands on desktop (nsec never sent back over IPC). Key-manager loads CryptoState on unlock; backward-compatible for direct callers until Epic 81 migrates them.
- **Phase 7: Pinned Rust Toolchain** — `rust-toolchain.toml` pins to `1.85.0` with `rustfmt`, `clippy`, and cross-compilation targets (Linux, macOS x86/ARM, Windows).
- **Phase 8: Single Instance Hardening** — Unminimize window on duplicate launch attempt for visual feedback.
- `bech32` crate added for nsec → hex conversion in Rust.

### Epic 91: Native VoIP Calling — Linphone SDK Expo Module

**llamenos-mobile repo (Expo Module + React hook):**
- `modules/llamenos-sip/` Expo Module wrapping Linphone SDK for iOS and Android
- TypeScript interface (`LlamenosSipModule.ts`) with types: SipConfig, CallState, RegistrationState, CallInfo, AudioDevice, MediaEncryptionMode, SipEventMap
- Graceful fallback via `requireOptionalNativeModule` — returns null in Expo Go
- iOS Swift implementation (LlamenosSipModule.swift, ~480 lines):
  - Linphone Core init with Opus/PCMU/PCMA codecs, SRTP encryption
  - CallKit integration (CXProvider + CXCallController) with UUID mapping
  - PushKit VoIP push (PKPushRegistry) — wakes app for incoming calls
  - Core.iterate() at 20ms via Timer
  - Audio device management (earpiece/speaker routing)
- Android Kotlin implementation (LlamenosSipModule.kt, ~450 lines):
  - Linphone Core with CoreListenerStub
  - ConnectionService (self-managed PhoneAccount via TelecomManager)
  - FCM token for VoIP push
  - Fallback notification when ConnectionService unavailable
  - LinphoneConnectionService.kt for native call UI
- `src/lib/voip.ts` — React hook (`useVoip()`) with state and call controls
  - Module-level functions: initializeVoip(), connectVoip(), disconnectVoip(), destroyVoip()
  - Native event subscription (module IS the EventEmitter in Expo SDK 52+)
  - AppState foreground re-sync
- `src/lib/voip-config.ts` — SIP config from server + VoIP push token registration
- Updated `app/call/[id].tsx` with VoIP controls (mute, speaker, hold, encryption badge)
- Updated `app/_layout.tsx` with VoIP initialization on auth

**llamenos repo (server-side SIP + VoIP push):**
- `src/worker/telephony/sip-tokens.ts` — SIP token generation for all 5 providers (Twilio, SignalWire, Vonage→Asterisk, Plivo, Asterisk)
- `GET /api/telephony/sip-token` and `GET /api/telephony/sip-status` endpoints
- `POST/DELETE /api/devices/voip-token` — VoIP push token management
- `src/worker/lib/voip-push.ts` — APNs VoIP push (PushKit) + FCM high-priority data messages
- Extended ringing service with VoIP push dispatch (best-effort, non-blocking)

### Epic 90: UniFFI Bindings for llamenos-core

**llamenos-core repo (shared Rust crypto crate):**
- UniFFI 0.28 proc-macro annotations on all public types and functions, gated behind `uniffi-bindgen` feature
- 8 structs annotated with `uniffi::Record`: KeyPair, KeyEnvelope, RecipientKeyEnvelope, EncryptedNote, EncryptedMessage, EncryptedKeyData, AuthToken
- CryptoError annotated with `uniffi::Error` + `flat_error` (serializes via Display for non-FFI-compatible `#[from]` variants)
- 15 functions exported directly via `#[uniffi::export]`, 7 via hex-string FFI wrappers in `src/ffi.rs`
- FFI wrappers convert `[u8; 32]`/`&[u8]` to hex strings and `&[T]` slices to `Vec<T>` at the FFI boundary
- `uniffi-bindgen` binary + `scripts/generate-bindings.sh` for binding generation
- `release-bindgen` profile (inherits release, strip=false to preserve UniFFI metadata)
- Generated Swift bindings (55KB) and Kotlin bindings in `bindings/`
- 22 tests pass with feature (17 original + 5 FFI-specific), 17 without

**llamenos-mobile repo (React Native Expo Module):**
- Expo Module at `modules/llamenos-core/` with `expo-module.config.json` for iOS/Android autolinking
- Swift implementation (`LlamenosCoreModule.swift`, 193 lines) — bridges all 22 UniFFI functions with dict↔struct helpers
- Kotlin implementation (`LlamenosCoreModule.kt`, 211 lines) — bridges all 22 functions with `System.loadLibrary("llamenos_core")`
- Android `build.gradle` with JNA dependency for UniFFI runtime
- TypeScript interface (`LlamenosCoreModule.ts`) with full type definitions for all native functions
- Platform-aware `crypto-provider.ts` — tries native Rust (UniFFI) first, falls back to JS (@noble/*) when unavailable
- Cross-compilation build script (`scripts/build-native-libs.sh`) for iOS (device + Apple Silicon sim) and Android (4 ABIs)

### Epic 88: Desktop & Mobile E2E Tests

**Desktop (llamenos repo, `desktop` branch):**
- WebdriverIO + `tauri-driver` test infrastructure for Tauri desktop app
- `tests/desktop/wdio.conf.ts` — config with auto-build, tauri-driver lifecycle
- 5 test specs: `launch.spec.ts` (window, title, no console errors), `navigation.spec.ts` (routes, auth redirects), `crypto.spec.ts` (keypair gen, PIN encrypt/decrypt, ECIES, Schnorr via Rust IPC), `tray.spec.ts` (hide/show/minimize/title), `single-instance.spec.ts` (plugin loaded, window count, second launch rejection)
- `.github/workflows/desktop-e2e.yml` — CI for Linux (xvfb) + Windows with tauri-driver
- `bun run test:desktop` script added

**Mobile (llamenos-mobile repo, `main` branch):**
- Detox 20.x + Jest 29 test infrastructure for iOS simulator + Android emulator
- `.detoxrc.js` — configs for ios.sim.debug/release, android.emu.debug/release
- `e2e/jest.config.js` — Detox Jest runner with ts-jest transform
- 5 test files: `auth.test.ts` (fresh install, onboarding, PIN entry), `dashboard.test.ts` (render, shift status, refresh, tab nav), `notes.test.ts` (list, empty state, scroll), `shifts.test.ts` (list, sign-up button, scroll), `admin.test.ts` (settings, theme toggle, language picker, tab cycling)
- `src/test-ids.ts` — centralized testID constants (50+ IDs)
- testID props added to 14 components/screens: login, onboarding, dashboard, notes, shifts, conversations, settings, PinInput, NoteCard, ShiftCard, CallCard, tab layout
- `.github/workflows/mobile-e2e.yml` — CI for iOS (macos-14) + Android (emulator)
- `bun run e2e:build:ios/android` and `bun run e2e:test:ios/android` scripts

### Epic 82: Desktop Route Verification
- [x] Fixed capabilities/default.json — removed references to unregistered plugins (updater, autostart)
- [x] Hardened CSP in tauri.conf.json — added font-src, worker-src, media-src, object-src, base-uri directives
- [x] Fixed platform.ts PIN encrypt/decrypt flow — encrypted data now stored/loaded via Tauri Store
- [x] Cleaned up Cargo.toml — removed unused plugin dependencies
- [x] Documented hub URL configuration design for native clients
- [x] Identified platform.ts is dead code (key-manager.ts imports key-store.ts directly) — documented for Epic 81

### Epic 87: Desktop Auto-Updater & Distribution
- [x] Tauri updater plugin registered with Ed25519 signing, GitHub Releases endpoint
- [x] tauri-plugin-process for app relaunch after update
- [x] createUpdaterArtifacts: true — signed .tar.gz, .nsis.zip, .AppImage bundles
- [x] updater:default + process:default capabilities added
- [x] UpdateChecker component — background check every 6h, download progress bar, restart prompt
- [x] CI workflow (tauri-release.yml) — macOS universal, Windows, Linux matrix build
- [x] Apple notarization support (via env secrets when configured)
- [x] Manifest generation script (generate-update-manifest.sh) — builds latest.json from .sig artifacts
- [x] GitHub Release publishing with all platform artifacts + latest.json

### Epic 89: Mobile UI Polish & Accessibility (`llamenos-mobile` repo)
- [x] NativeWind dark mode with CSS variables matching web app's OKLCH teal/amber palette (light + dark tokens)
- [x] Theme toggle (light/dark/system) persisted via MMKV settings store, synced via nativewind colorScheme.set()
- [x] DM Sans font loading via expo-font (Regular/Medium/Bold TTF bundled)
- [x] Haptic feedback via expo-haptics: semantic methods (light/medium/heavy/warning/success/error/selection) on call answer, hangup, spam, shift sign-up/drop, PIN entry, profile save, pull-to-refresh
- [x] Animated skeleton loading components (NoteCardSkeleton, ConversationCardSkeleton, VolunteerCardSkeleton, AuditEntrySkeleton, ShiftCardSkeleton, ListSkeleton) with reanimated pulse
- [x] Screen error boundaries with retry UI using react-error-boundary
- [x] Offline/relay disconnected banner using NetInfo + WebSocket relay context state
- [x] Toast notifications (react-native-toast-message) with theme-aware custom config (success/error/info)
- [x] Language picker with 13 locales, RTL support for Arabic via I18nManager.forceRTL, restart alert
- [x] Language display names and persistence via Zustand settings store
- [x] Accessibility: labels, roles, states, hints on all interactive elements (CallCard, NoteCard, ShiftCard, PinInput, RelayStatus, EncryptedContent, ConversationRow)
- [x] accessibilityRole, accessibilityLiveRegion, accessibilityElementsHidden for decorative elements
- [x] hitSlop on small touch targets (buttons, icons) for 44pt minimum
- [x] Theme-aware tab bar, headers, RefreshControl tint colors
- [x] Reduced motion tracking via AccessibilityInfo.isReduceMotionEnabled
- [x] Mutation retry config for offline resilience (React Query: 2 retries, exponential backoff)
- [x] SplashScreen management — hidden after fonts load
- [x] StatusBar style synced with resolved color scheme

### Epic 86: Mobile Push Notifications (server + mobile)
- [x] Crypto labels: LABEL_PUSH_WAKE, LABEL_PUSH_FULL added to both repos
- [x] Server types: DeviceRecord, WakePayload, FullPushPayload, PushNotificationType, Env push bindings
- [x] Push encryption: two-tier ECIES (wake key for lock screen, nsec for full content)
- [x] FCM client wrapper: fcm-cloudflare-workers with FcmOptions/sendToToken API
- [x] APNs integration: @fivesheepco/cloudflare-apns2 with data field for encrypted payloads
- [x] PushDispatcher: sendToVolunteer, sendToAllOnShift with stale token cleanup
- [x] Device registration API: POST /api/devices/register, DELETE /api/devices
- [x] IdentityDO: devices:${pubkey} storage, register/cleanup/delete methods, 5 device limit
- [x] CallRouterDO: voicemail push dispatch after KIND_CALL_VOICEMAIL WebSocket event
- [x] ConversationDO routes: message push to assigned volunteer, assignment push on claim
- [x] Messaging router: inbound message push dispatch via executionCtx.waitUntil
- [x] ShiftManagerDO: 5-minute alarm for shift reminders 15 min before start, dedup tracking
- [x] Mobile wake key: secp256k1 keypair in SecureStore (AFTER_FIRST_UNLOCK)
- [x] Mobile push registration: native APNs/FCM token + wake key sent to server
- [x] Notification categories: message (open, mark read), voicemail (listen), shift (view shifts)
- [x] Notification handlers: background display, tap navigation, cold start handling
- [x] Device unregistration on logout
- [x] Android notification channels config in app.json
- [x] Both repos typecheck clean

### Epic 85: Mobile Admin Screens & E2EE Messaging (`llamenos-mobile` repo)
- [x] Permission system (PBAC) ported from web — 70 permissions, 13 domains, wildcard support
- [x] usePermission, usePermissions, useIsAdmin hooks with React Query cached /api/auth/me
- [x] PermissionGuard component for declarative UI gating
- [x] Admin screens: volunteers (list, add with keypair gen, invite, delete), bans (add/remove), audit log (paginated, filter chips), hub settings (collapsible sections with permission gates)
- [x] Conversations tab with waiting/active groups, ChannelBadge (SMS/WhatsApp/Signal/RCS/Web), relative time
- [x] Conversation thread view with E2EE compose (encryptMessage per-reader envelopes), MessageBubble decryption
- [x] Admin navigation links in settings screen
- [x] Tab layout updated with conversations tab gated by conversations:read-assigned permission
- [x] Root layout updated with conversation/[id] and admin route definitions
- [x] All 15 files pass typecheck clean

### Epic 83: Mobile Foundation & Auth Flow (`llamenos-mobile` repo)
- [x] NativeWind v4 + Tailwind v3 with shared design tokens (colors match web app)
- [x] Full crypto layer: ECIES, Schnorr, XChaCha20-Poly1305, HKDF, PBKDF2 via @noble/* with RN polyfills
- [x] PIN-encrypted key storage via expo-secure-store (WHEN_UNLOCKED_THIS_DEVICE_ONLY)
- [x] Key manager with AppState-based auto-lock (5min idle, 30s background grace)
- [x] Hub key manager for E2EE envelope encryption (generateHubKey, wrap/unwrap, rotate)
- [x] WebSocket relay client (WebSocket property handlers for RN, NIP-42 auth, event dedup)
- [x] Zustand stores with MMKV v4 persistence (auth state, hub config)
- [x] React Query with AppState focus/online managers
- [x] API client with Schnorr auth tokens and hub discovery (/api/config)
- [x] i18n: 13 locales via react-i18next + expo-localization
- [x] Login screen: hub URL configuration, PIN unlock, nsec import
- [x] Onboarding screen: keypair generation, nsec backup, PIN setup/confirm
- [x] Tab navigator: dashboard, shifts, notes, settings (placeholders for Epic 84)
- [x] Auth redirect from root index based on Zustand auth state
- [x] Cleaned up old scaffold files (.gitkeep, auth.ts, core/index.ts, removed empty dirs)

## 2026-02-25: Documentation Overhaul (`next` branch)

### ZK Architecture Documentation
- [x] Security docs: THREAT_MODEL (WebSocket relay trust, audit log tamper detection, admin key separation, hub key compromise, reproducible builds, client-side transcription), DEPLOYMENT_HARDENING (Caddy ingress, WebSocket relay operations, build verification), KEY_REVOCATION_RUNBOOK (verification checklists, CLI rotation), DATA_CLASSIFICATION (E2EE messaging, hash-chained audit, encrypted shifts), security/README (E2EE at rest for messages, additional security features table)
- [x] Architecture docs: E2EE_ARCHITECTURE (implemented status, past-tense history, resolved questions), llamenos-protocol (NIP-42 auth, envelope encryption, all 25 crypto labels, hub event encryption, audit integrity)
- [x] New docs: RELAY_OPERATIONS.md (WebSocket relay/Nosflare deployment, hardening, monitoring, backup, troubleshooting), REPRODUCIBLE_BUILDS.md (trust model, verification, scope, CI, SLSA)
- [x] Deployment docs: QUICKSTART (relay setup, test checklist), RUNBOOK (relay troubleshooting, server WebSocket secret rotation, relay monitoring/backup, scaling), Helm values.yaml (Caddy ingress, serverWebSocketSecret)
- [x] Project docs: CLAUDE.md (ZK patterns, gotchas, directory structure)

## 2026-02-25: Zero-Knowledge Architecture (`next` branch)

### Epic 76.0: Security Foundations
- [x] Created `@shared/crypto-labels.ts` — authoritative domain separation constants for all crypto operations
- [x] Refactored all hardcoded label strings in client and server crypto modules
- [x] Fixed device provisioning SAS verification
- [x] Generic backup file format

### Epic 76.1: Worker-Relay Communication
- [x] `WebSocketPublisher` interface with CF (DO service binding) and Node.js (persistent WebSocket) implementations
- [x] Server keypair derivation from `SERVER_NOSTR_SECRET` env var
- [x] Nosflare service binding in wrangler.jsonc
- [x] WebSocket relay in docker-compose.yml for Node.js path

### Epic 76.2: Key Architecture Redesign
- [x] Hub key = `crypto.getRandomValues(32)`, ECIES-wrapped per member
- [x] `hub-key-manager.ts` client library for hub key distribution
- [x] Multi-admin envelope support: `adminPubkeys[]` → `adminEnvelopes[]`
- [x] Updated RecordsDO, ConversationDO storage for envelope arrays
- [x] Identity + decryption key separation in bootstrap-admin

### Epic 76: WebSocket Relay Real-Time Sync
- [x] Complete WebSocket removal — deleted `ws.ts`, `websocket.ts`, `websocket-pair.ts`
- [x] WebSocket-only real-time broadcasts via ephemeral kind 20001 events
- [x] Client-side WebSocket relay subscription hooks
- [x] Server-authoritative call state (REST + DO serialization, relay for notification)

### Epic 74: E2EE Messaging Storage
- [x] Envelope encryption: per-message random symmetric key, ECIES-wrapped per reader
- [x] Server encrypts inbound messages on webhook receipt (plaintext discarded immediately)
- [x] Client-side decryption in ConversationThread component
- [x] Conversation reassignment re-wrapping support

### Epic 77: Metadata Encryption
- [x] Per-record DO storage keys (`callrecord:${id}`, `audit:${id}`)
- [x] Encrypted call record metadata with admin envelopes
- [x] Hash-chained audit log (SHA-256 `previousEntryHash` + `entryHash`)
- [x] Client-side decryption in calls.tsx and notes.tsx
- [x] Fixed `audit:_lastHash` collision with audit entry list queries

### Epic 78: Client-Side Transcription
- [x] Migrated transcription service from dual-ECIES to envelope encryption pattern
- [x] Removed dead `encryptForPublicKey` from both client and server crypto modules
- [x] `@huggingface/transformers` v3.8.1 — ONNX Runtime single-threaded WASM (no SharedArrayBuffer)
- [x] AudioWorklet ring buffer (`audio-capture-worklet.js`) — 60s buffer, 30s chunks, 5s overlap
- [x] Web Worker transcription (`transcription-worker.ts`) — Whisper ONNX in isolated worker thread
- [x] `TranscriptionManager` orchestrator + `useTranscription` React hook
- [x] Settings UI: enable/disable toggle, model selection (tiny/base, en/multilingual)
- [x] Auto-save encrypted transcript note on call hangup
- [x] "Transcribes your speech only" limitation documented in UI
- [x] E2E tests for settings persistence and configuration

### Epic 79: Reproducible Builds
- [x] Build-time defines (`__BUILD_TIME__`, `__BUILD_COMMIT__`, `__BUILD_VERSION__`) in Vite, esbuild, Wrangler
- [x] `src/globals.d.ts` type declarations for build-time constants
- [x] `Dockerfile.build` — canonical build environment with pinned Bun image
- [x] `scripts/verify-build.sh` — Docker-based verification against GitHub Release checksums
- [x] `/api/config/verify` informational endpoint
- [x] CI: `SOURCE_DATE_EPOCH`, Worker bundle capture, `CHECKSUMS.txt` in releases, SLSA attestation

## 2026-02-24: Two-Way Messaging with Volunteer Assignment

### Epics 68-73: Volunteer Messaging Assignment & Two-Way Conversation UI

#### Epic 68: Messaging Channel Permissions

- [x] Added `supportedMessagingChannels` and `messagingEnabled` fields to Volunteer type
- [x] Added channel-specific claim permissions (`conversations:claim-sms`, `conversations:claim-whatsapp`, etc.)
- [x] Updated default volunteer role with all channel claim permissions
- [x] Added `canClaimChannel()` and `getClaimableChannels()` helper functions
- [x] Updated conversations route to validate channel permissions on claim
- [x] Updated conversation listing to filter by volunteer's supported channels
- [x] Added MessagingChannelsCard UI component on volunteer profile page

#### Epic 69: Messaging Auto-Assignment

- [x] Added volunteer load tracking to ConversationDO (`getVolunteerLoad()`, `getAllVolunteerLoads()`)
- [x] Implemented `incrementLoad()` / `decrementLoad()` for conversation assignment tracking
- [x] Added `autoAssignConversation()` endpoint in ConversationDO
- [x] Updated `claimConversation()` to increment load counter
- [x] Updated `updateConversation()` to handle load changes on reassign/close
- [x] Updated alarm handler to decrement load on auto-close
- [x] Implemented `tryAutoAssign()` function in messaging router
- [x] Auto-assignment algorithm: filters by shift, channel capability, messaging enabled, not on-break, load capacity

#### Epic 70: Conversation Reassignment UI

- [x] Added `ReassignDialog` component with volunteer picker
- [x] Shows volunteer name, current load, channel capability, on-break status
- [x] Sorted volunteers by capability (capable first) then load (ascending)
- [x] Added "Reassign" button to conversation header (admin only)
- [x] Added "Return to queue" button to unassign and return to waiting status
- [x] Added `getVolunteerLoads()` API function
- [x] Added `/conversations/load` API route (admin only)

#### Epic 71: Message Delivery Status Tracking

- [x] Added `MessageDeliveryStatus` type (`pending`, `sent`, `delivered`, `read`, `failed`)
- [x] Added status fields to EncryptedMessage type (`status`, `deliveredAt`, `readAt`, `failureReason`, `retryCount`)
- [x] Added `MessageStatusUpdate` interface for webhook status callbacks
- [x] Added `parseStatusWebhook()` method to MessagingAdapter interface
- [x] Implemented status parsing in TwilioSmsAdapter (Twilio status callbacks)
- [x] Implemented status parsing in WhatsAppAdapter (Meta + Twilio modes)
- [x] Added `/messages/status` endpoint to ConversationDO
- [x] External ID mapping storage for status lookup
- [x] Status progression logic (only advance status, except failed can override)
- [x] Updated messaging router to check for status webhooks before parsing as message
- [x] WebSocket broadcast of `message:status` events

#### Epic 72: Volunteer Load Balancing

- [x] Implemented as part of Epic 69 (load tracking + auto-assignment)
- [x] `maxConcurrentPerVolunteer` setting enforced during auto-assignment

#### Epic 73: Enhanced Two-Way Conversation UI

- [x] Added delivery status icons to outbound messages in ConversationThread
- [x] Status indicators: Clock (pending), Check (sent), CheckCheck (delivered), CheckCheck+blue (read), AlertCircle (failed)
- [x] Failed message reason displayed as tooltip
- [x] WebSocket listener for `message:status` events

### Files Changed (20+ files)

- New: `src/client/components/ReassignDialog.tsx`, `docs/epics/epic-68-*` through `epic-73-*`
- Modified: `src/worker/types.ts`, `src/shared/permissions.ts`, `src/worker/routes/conversations.ts`, `src/worker/durable-objects/conversation-do.ts`, `src/worker/messaging/router.ts`, `src/worker/messaging/adapter.ts`, `src/worker/messaging/sms/twilio.ts`, `src/worker/messaging/whatsapp/adapter.ts`, `src/client/lib/api.ts`, `src/client/lib/hooks.ts`, `src/client/routes/conversations.tsx`, `src/client/routes/volunteers_.$pubkey.tsx`, `src/client/components/ConversationThread.tsx`
- Added shadcn components: checkbox, scroll-area

## 2026-02-24: Complete All Remaining Epics

### Phase 1: Security Completion
- [x] **L-9 Panic Wipe** — Triple-Escape detector, full storage wipe, red flash overlay (`panic-wipe.ts`, `panic-wipe-indicator.tsx`)
- [x] **L-10 SRI Hashes** — Vite closeBundle plugin computing SHA-384 for all precached assets, patching fetch in sw.js (`sri-workbox-plugin.ts`)
- [x] **PIN Challenge Re-auth** — PIN dialog before sensitive actions (phone unmask), max 3 attempts, auto-wipe on failure (`use-pin-challenge.ts`, `pin-challenge-dialog.tsx`)

### Phase 2: Epic 63 — RCS Channel
- [x] Google RBM REST adapter with JWT service account auth (`rcs/rbm-client.ts`, `rcs/adapter.ts`)
- [x] RBM API types for webhooks, rich cards, suggestions (`rcs/types.ts`)
- [x] Admin UI section: agent ID, service account key, webhook URL, fallback toggle, connection test (`rcs-channel-section.tsx`)
- [x] Shared types extension: `'rcs'` in MessagingChannelType, RCSConfig, channel maps
- [x] Router + factory integration for webhook handling

### Phase 3: Epic 62 — Message Blasts
- [x] Subscriber management in ConversationDO (CRUD, import, keyword opt-in/out, HMAC preference tokens)
- [x] Blast CRUD and delivery via DO alarms (rate-limited batch sending)
- [x] TCPA-compliant STOP keyword always recognized
- [x] Blast API routes proxying to ConversationDO
- [x] Public subscriber preferences endpoint (token-validated, no auth)
- [x] Client UI: BlastComposer, SubscriberManager, BlastSettingsPanel, blasts route, preferences route
- [x] Keyword interception in messaging webhook router

### Phase 4: Post-Launch Features
- [x] **Call Recording Playback** — On-demand fetch from telephony provider via `TelephonyAdapter.getRecordingAudio()`, permission-gated (admin or answering volunteer), lazy-loading `<RecordingPlayer>` component in calls and notes views
- [x] **CF Tunnel** — `scripts/dev-tunnel.sh` wrapping cloudflared for local dev webhook testing

### Phase 5: Epic 66 — Deployment Hardening
- [x] Ansible: 8 roles (common, ssh-hardening, firewall, kernel-hardening, fail2ban, docker, llamenos, backup)
- [x] Ansible: 4 playbooks (harden, deploy, update, backup) with Jinja2 templates
- [x] Ansible: justfile with generate-secrets, encrypt-vars, and all deployment commands
- [x] OpenTofu: Hetzner module with cloud-init hardening + generic module for Ansible inventory
- [x] `docs/QUICKSTART.md` — step-by-step deployment guide
- [x] `docs/RUNBOOK.md` — operational runbook (secret rotation, incident response, backup recovery)

## 2026-02-18: Epic 55 — Multi-Platform Deployment (Docker Compose + Helm)

### Platform Abstraction Layer
- [x] `src/platform/types.ts` — shared interfaces: StorageApi, DOContext, BlobStorage, TranscriptionService
- [x] `src/platform/index.ts` — Node.js build entry (esbuild alias for `cloudflare:workers`)
- [x] `src/platform/cloudflare.ts` — CF re-export (thin wrapper)
- [x] `src/platform/node/durable-object.ts` — SQLite-backed DO shim (better-sqlite3, WAL mode, setTimeout alarms)
- [x] `src/platform/node/websocket-pair.ts` — WebSocketPair polyfill (EventEmitter-based connected shim sockets)
- [x] `src/platform/node/blob-storage.ts` — S3/RustFS client (@aws-sdk/client-s3)
- [x] `src/platform/node/transcription.ts` — HTTP client for faster-whisper container
- [x] `src/platform/node/env.ts` — Node.js env shim (Docker secrets + env vars, DO singletons)
- [x] `src/platform/node/server.ts` — @hono/node-server entry point with static files + WS upgrade
- [x] `src/platform/node/cf-types.d.ts` — Type declarations replacing @cloudflare/workers-types

### Worker Refactoring (CF deployment unchanged)
- [x] `src/worker/types.ts` — Platform-aware Env with DOStub, DONamespace, BlobStorage, TranscriptionService
- [x] `src/worker/lib/do-access.ts` — Changed DurableObjectStub → DOStub
- [x] `src/worker/services/audit.ts` — Changed DurableObjectStub → DOStub
- [x] `src/worker/lib/helpers.ts` — Structural typing for stub parameter
- [x] `src/worker/lib/auth.ts` — Structural typing for identityDO parameter
- [x] `src/worker/app.ts` — Added `/api/health` endpoint

### Build System
- [x] `esbuild.node.mjs` — Node.js build config with `cloudflare:workers` alias + path aliases
- [x] `package.json` — Added build:node, build:docker, start:node scripts + new dependencies

### Docker Infrastructure
- [x] `deploy/docker/Dockerfile` — Multi-stage build (frontend + backend + production)
- [x] `deploy/docker/docker-compose.yml` — app, caddy, rustfs (core) + whisper, asterisk, signal (profiles)
- [x] `deploy/docker/Caddyfile` — Reverse proxy with security headers
- [x] `deploy/docker/.env.example` — All configuration variables documented
- [x] `.dockerignore` — Build exclusions

### Helm Chart (`deploy/helm/llamenos/`)
- [x] `Chart.yaml` — apiVersion v2, appVersion 0.9.1
- [x] `values.yaml` — Configurable app, RustFS, Whisper, Asterisk, Signal, ingress, secrets
- [x] `templates/` — deployment-app, service-app, ingress, secret, pvc-app, deployment-rustfs, deployment-whisper, serviceaccount, NOTES.txt, _helpers.tpl

### CI/CD
- [x] `.github/workflows/docker.yml` — Build + push to GHCR on tag push (app + asterisk-bridge images)

### New Dependencies
- @hono/node-server, @hono/node-ws, better-sqlite3, @aws-sdk/client-s3, ws, esbuild
- @types/better-sqlite3, @types/ws (devDeps)

### Architecture Notes
- DO source files unchanged — esbuild aliases `cloudflare:workers` to Node.js shim at build time
- SQLite single-writer means Node.js deployment is single-replica (appropriate for crisis hotline scale)
- WebSocket hibernation (CF-only feature) not needed — Node.js server stays running, connections stay open
- Self-hosted deployments start fresh; no data migration from CF needed

## 2026-02-17: Epic 54 — Device-Centric Auth & Forward-Secret Encryption

### Phase 1: PIN-First Local Key Store
- [x] `key-manager.ts` singleton — holds nsec in closure variable only, zeroed on lock
- [x] `unlock(pin)` decrypts nsec from localStorage via PBKDF2 (600K iterations) + XChaCha20-Poly1305
- [x] `importKey(nsec, pin)` for onboarding/recovery
- [x] Auto-lock on idle timeout + `document.hidden`
- [x] Login page redesigned: PIN entry as primary (stored key) or recovery options (no stored key)
- [x] Removed nsec from sessionStorage entirely — `storeSession()`/`getStoredSession()` deleted
- [x] `getAuthHeaders()` uses key-manager token if unlocked, session token if locked
- [x] Components show "Enter PIN to decrypt" overlay when key is locked

### Phase 2: Device Linking (Signal-Style QR Provisioning)
- [x] Provisioning room relay via IdentityDO with `provision:` prefix, 5-min TTL
- [x] Ephemeral ECDH key exchange protocol (new device generates temp keypair)
- [x] QR code display and manual code entry fallback
- [x] `/link-device` standalone page for new devices
- [x] Settings > Linked Devices section with code input
- [x] Provisioning rooms auto-cleaned via DO alarm

### Phase 3: Per-Note Ephemeral Keys (Forward Secrecy)
- [x] Each note encrypted with unique random 32-byte key (XChaCha20-Poly1305)
- [x] Per-note key wrapped via ECIES for each reader (author + admin envelopes)
- [x] `encryptNote()` / `decryptNote()` with `decryptNoteLegacy()` for backward compat
- [x] Note model updated with `authorEnvelope` and `adminEnvelope` fields
- [x] Compromising identity key no longer reveals past notes

### Phase 4: Simplified Onboarding & Recovery
- [x] nsec never displayed to users — replaced with Base32 recovery key (128-bit entropy)
- [x] Recovery key verification during onboarding (character check)
- [x] Mandatory encrypted backup download before proceeding
- [x] nsec flows directly from `generateKeyPair()` into `keyManager.importKey()`

### E2E Tests
- [x] `tests/device-linking.spec.ts` — 11 tests for /link-device page, settings section, login integration
- [x] `/link-device` added to public paths in `__root.tsx`

### Files Changed (16+ files)
- New: `src/client/lib/key-manager.ts`, `src/client/lib/provisioning.ts`, `src/client/components/qr-provisioning.tsx`, `src/client/routes/link-device.tsx`, `src/worker/routes/provisioning.ts`, `tests/device-linking.spec.ts`
- Modified: `src/client/lib/auth.tsx`, `api.ts`, `ws.ts`, `crypto.ts`, `backup.ts`, `src/client/routes/login.tsx`, `onboarding.tsx`, `settings.tsx`, `__root.tsx`, `src/worker/durable-objects/identity-do.ts`, `src/worker/app.ts`, `src/shared/types.ts`

## 2026-02-17: Epic 53 — Deep Security Audit & Hardening (Round 5)

### Critical Fixes
- [x] Login endpoint now verifies Schnorr signature before returning user info (was unauthenticated role enumeration)
- [x] CAPTCHA digits generated server-side with CSPRNG, stored in SettingsDO with one-time-use verification
- [x] Removed `Math.random()` from all CAPTCHA paths — replaced with `crypto.getRandomValues()`

### High Fixes
- [x] Invite redemption requires Schnorr signature proof of private key ownership + rate limiting
- [x] Upload chunk/status endpoints verify `uploadedBy === pubkey` ownership
- [x] Sessions revoked (`revokeAllSessions`) on volunteer deactivation/deletion
- [x] Onboarding backup encrypted with PBKDF2 + XChaCha20-Poly1305 (was plaintext nsec JSON)
- [x] HKDF salt added: `llamenos:hkdf-salt:v1` for note encryption key derivation
- [x] Recovery key PBKDF2 uses per-backup random salt (was static `'llamenos:recovery'`)
- [x] TwiML XML injection prevented — `escapeXml()` for all `<Say>`/`<Play>` content

### Medium Fixes
- [x] WebAuthn login rate limited (10/min per IP) on options + verify
- [x] CORS `Vary: Origin` header added to prevent cache poisoning
- [x] Notes endpoints guarded with `volunteerOrAdminGuard` (reporters blocked)
- [x] WebAuthn `userVerification` changed from `'preferred'` to `'required'`
- [x] IP hash increased from 64-bit to 96-bit truncation
- [x] Asterisk webhook: constant-time HMAC comparison + 5-minute timestamp replay protection
- [x] Asterisk bridge bound to localhost only

### Architecture Notes (documented, not fixed)
- Schnorr token 5-min replay window — mitigated by HTTPS; full nonce system deferred
- nsec in sessionStorage — mitigated by CSP; WebAuthn recommended as primary auth
- Ban list bypassable via caller-ID spoofing — PSTN limitation
- WebSocket rate limit resets on DO hibernation — acceptable for current usage

### Files Changed (21 files)
- `src/worker/routes/auth.ts`, `telephony.ts`, `invites.ts`, `uploads.ts`, `volunteers.ts`, `notes.ts`, `webauthn.ts`
- `src/worker/lib/crypto.ts`, `webauthn.ts`
- `src/worker/middleware/cors.ts`
- `src/worker/durable-objects/settings-do.ts`, `identity-do.ts`
- `src/worker/telephony/adapter.ts`, `twilio.ts`, `vonage.ts`, `plivo.ts`, `asterisk.ts`
- `src/client/lib/crypto.ts`, `backup.ts`, `api.ts`
- `src/client/routes/onboarding.tsx`
- `asterisk-bridge/src/index.ts`

## 2026-02-17: Epics 48–52 — UI/UX Design Overhaul with Teal Brand Identity

### Visual Identity
- [x] Brand tokens: deep teal primary (oklch 195°), warm amber accent (oklch 70°), warm off-white/blue-charcoal backgrounds in light/dark modes
- [x] New logo: shield + phone handset "L" mark with signal waves (SVG at all sizes)
- [x] Typography: DM Sans for body/headings via Google Fonts
- [x] Login page: radial gradient background, logo mark with fade-in animation, trust badge
- [x] Onboarding: amber warning cards, logo mark throughout, gradient backgrounds
- [x] Sidebar: logo mark, teal active nav border (3px), teal admin section headers
- [x] Dashboard: tinted stat cards (green active calls, teal on-shift, amber on-break)
- [x] All pages: consistent teal page title icons, warm card shadows

### Marketing Site
- [x] Teal accent palette applied throughout
- [x] Inline SVG logo replacing text-only branding
- [x] Enhanced hero glow effect
- [x] Teal hover borders on feature cards
- [x] Teal docs sidebar active states

### Files Changed (32 files)
- New: `src/client/components/logo-mark.tsx`
- Modified: `index.html`, all SVG icons (`favicon.svg`, `apple-touch-icon.svg`, `pwa-*.svg`), `src/client/app.css`, all route pages, marketing site components and layouts
- All 214 E2E tests passing, both app and site (182 pages) build cleanly

## 2026-02-17: Epics 37–41 — Codebase Refactoring & Test Coverage

### Epic 37: Split Admin Settings
- [x] Split `admin/settings.tsx` (1,135 → 231 lines) into 8 focused section components under `components/admin-settings/`
- [x] Components: call-settings, custom-fields, ivr-languages, passkey-policy, spam, telephony-provider, transcription, voice-prompts

### Epic 38: Shared Voice Prompts
- [x] Extracted ~800 lines of duplicated voice prompts from 4 telephony adapters into `shared/voice-prompts.ts`
- [x] Single source of truth for all IVR prompt text across Twilio, Vonage, Plivo, and Asterisk

### Epic 39: Split Notes Page
- [x] Split `notes.tsx` (644 → 395 lines), extracting `NewNoteForm`, `NoteEditForm`, and shared `CustomFieldInputs` components

### Epic 40: E2E Test Coverage Expansion
- [x] 30 new E2E tests across 3 files: `audit-log.spec.ts`, `shift-management.spec.ts`, `ban-management.spec.ts`
- [x] Total: 160 tests passing

### Epic 41: Type Safety
- [x] Fixed all `as any`/`unknown` casts in 6 files (volunteers route, volunteer-multi-select, audit page, volunteer profile, webauthn, webrtc)

### SessionManagerDO Split (pre-requisite refactor)
- [x] Split the 1,031-line `SessionManagerDO` "god object" (237-line `fetch()` with 40+ if-branches) into 3 focused DOs:
  - **IdentityDO**: volunteers, invites, WebAuthn credentials, sessions
  - **SettingsDO**: all config, IVR audio, rate limiting, fallback group
  - **RecordsDO**: bans, notes, audit log
- [x] Introduced `DORouter` — lightweight method+path router with `:param` extraction, replacing if-chain routing across all DOs
- [x] All 131 E2E tests pass with zero behavior changes

### Files Changed (34+ files)
- New: `src/worker/durable-objects/identity-do.ts`, `settings-do.ts`, `records-do.ts`, `src/worker/lib/do-router.ts`, `src/shared/voice-prompts.ts`, `src/client/components/admin-settings/*.tsx`, `src/client/components/notes/*.tsx`, 3 new test files
- Deleted: `src/worker/durable-objects/session-manager.ts`
- Net: -1,553 / +2,299 lines (significant deduplication)

## 2026-02-17: Epics 42–47 — Multi-Channel Messaging, Reporter Role & In-App Guidance

### Epic 42: Messaging Architecture Foundation
- [x] `MessagingAdapter` interface with `sendMessage()`, `sendMediaMessage()`, `parseInboundWebhook()`, `validateWebhook()`
- [x] Threaded conversations with `ConversationDO` Durable Object
- [x] `GET/POST /conversations`, `GET/POST /conversations/:id/messages` API routes
- [x] Real-time conversation updates via WebSocket (`conversation:new`, `message:new`)
- [x] Conversation list + detail UI with message bubbles, timestamps, direction indicators
- [x] Inbound webhook routing to correct channel adapter
- [x] Conversations nav link (visible when messaging channels enabled)
- [x] i18n: `conversations.*` keys in all 13 locales
- [x] 6 E2E tests for conversation UI

### Epic 43: Admin Setup Wizard
- [x] `/setup` route with multi-step guided wizard (name, channels, providers)
- [x] Channel selection cards (Voice, SMS, WhatsApp, Signal, Reports) with toggle
- [x] Provider configuration per channel with credential forms
- [x] `setupCompleted` flag in config context
- [x] Auto-redirect to setup on first admin login when not completed
- [x] i18n: `setupWizard.*` keys in all 13 locales
- [x] 10 E2E tests for setup wizard flow

### Epic 44: SMS Channel
- [x] SMS adapters for Twilio, SignalWire, Vonage, Plivo (implements MessagingAdapter)
- [x] Inbound SMS webhook parsing and signature validation per provider
- [x] Auto-response with configurable welcome message
- [x] SMS settings in admin panel (enable/disable, welcome message)
- [x] Provider-specific message format handling

### Epic 45: WhatsApp Business Channel
- [x] WhatsApp Cloud API adapter (Meta Graph API v21.0)
- [x] Template message support for initiating conversations
- [x] 24-hour messaging window handling
- [x] Webhook verification (hub.verify_token challenge)
- [x] Media message support (images, documents, audio)
- [x] WhatsApp settings in admin panel

### Epic 46: Signal Channel
- [x] Signal adapter via signal-cli-rest-api bridge
- [x] Health monitoring with graceful degradation
- [x] Voice message transcription via Workers AI Whisper
- [x] Signal settings in admin panel (bridge URL, phone number)

### Epic 47: Reporter Role & Encrypted File Uploads
- [x] `reporter` role with restricted permissions (reports only)
- [x] Reporter invite flow with role selector (volunteer/admin/reporter)
- [x] Encrypted report submission (ECIES for body, plaintext title)
- [x] Report categories and status tracking (open/claimed/resolved)
- [x] Report claiming and threaded replies
- [x] Reporter-specific navigation (reports + help only)
- [x] `UserRole` type consolidated in shared/types.ts
- [x] 46 E2E tests across reports, setup wizard, and conversations

### In-App Guidance & Help
- [x] `/help` route with FAQ sections (Getting Started, Calls & Shifts, Notes & Encryption, Administration)
- [x] Role-specific guides (Admin Guide, Volunteer Guide, Reporter Guide)
- [x] Quick reference cards (Keyboard Shortcuts, Security)
- [x] Collapsible FAQ items with expand/collapse
- [x] Quick Navigation links grid
- [x] Getting Started checklist on admin dashboard (tracks setup progress)
- [x] Help link in sidebar navigation for all user roles
- [x] Help command in command palette
- [x] 10 E2E tests for help features
- [x] 214 total E2E tests passing (0 regressions)

## 2026-02-11: Epic 32 — Multi-Provider Telephony Configuration

### Epic 32: Provider Configuration System
- [x] Shared types: `TelephonyProviderConfig`, `TelephonyProviderType`, `PROVIDER_REQUIRED_FIELDS`, `TELEPHONY_PROVIDER_LABELS`
- [x] Refactored `getTelephony()` from sync to async — reads provider config from SessionManagerDO, falls back to Twilio env vars
- [x] TwilioAdapter: made fields/methods `protected`, added `getApiBaseUrl()` / `getRecordingBaseUrl()` for SignalWire inheritance
- [x] Updated all `getTelephony()` call sites (telephony routes, ringing service, transcription service)
- [x] SessionManagerDO: `settings:telephony-provider` storage with validation (provider type, required fields, E.164 phone)
- [x] API routes: `GET/PATCH /settings/telephony-provider`, `POST /settings/telephony-provider/test` (connection test)
- [x] Admin settings UI: provider dropdown, per-provider credential forms, test connection button, save button
- [x] Not-implemented warnings for vonage/plivo/asterisk (awaiting Epic 33)
- [x] Deep link support: `?section=telephony-provider` auto-expands section
- [x] i18n: `telephonyProvider.*` (30+ keys) + `telephonyProviderChanged` audit event in all 13 locales
- [x] 11 new E2E tests: section visibility, env fallback, provider dropdown, field switching, save/reload persistence, connection test, deep link
- [x] 119 total E2E tests passing (0 regressions)
- [x] Epic docs created: `docs/epics/epic-32` through `epic-36` for full multi-provider plan

## 2026-02-12: Epics 33–36 — Multi-Provider Telephony (Cloud Adapters, WebRTC, Asterisk, Docs)

### Epic 33: Cloud Provider Adapters
- [x] SignalWire adapter — extends TwilioAdapter with Space URL override and custom auth
- [x] Vonage adapter — NCCO JSON format, JWT auth, Nexmo API endpoints
- [x] Plivo adapter — Plivo XML format, Auth ID/Token, Plivo API endpoints
- [x] All adapters implement full TelephonyAdapter interface (IVR, CAPTCHA, recording, voicemail, queue, parallel ringing)
- [x] Factory switch in `getTelephony()` instantiates correct adapter based on provider config
- [x] Provider-specific webhook parsing and validation

### Epic 34: WebRTC Volunteer Calling
- [x] WebRTC token generation API (`POST /api/telephony/webrtc-token`) with provider-specific tokens
- [x] Twilio, SignalWire, Vonage, Plivo token generation implementations
- [x] Volunteer call preference model: `callPreference: 'phone' | 'webrtc' | 'both'`
- [x] Call preference UI in volunteer settings with radio buttons + descriptions
- [x] WebRTC configuration section in admin telephony provider settings (API Key SID, Secret, TwiML App SID)
- [x] WebRTC toggle enables/disables browser calling per provider
- [x] Disabled browser/both options when admin hasn't configured WebRTC
- [x] `webrtc.ts` client library with provider abstraction (init, accept, hangup, mute, status)
- [x] `webrtc-call.tsx` component with answer/hangup/mute buttons and call timer
- [x] i18n: `callPreference`, `webrtcConfig`, `enableWebrtc`, API key labels in all 13 locales
- [x] 10 new E2E tests: preference section, default selection, disabled options, deep link, WebRTC config toggle, per-provider fields, persistence
- [x] 131 total E2E tests passing

### Epic 35: Asterisk ARI Adapter
- [x] Asterisk adapter (`src/worker/telephony/asterisk.ts`) — JSON command format for ARI bridge
- [x] Maps IVR/CAPTCHA/recording/voicemail flows to ARI commands (speak, play, gather, queue, bridge, record, hangup)
- [x] HMAC-SHA256 webhook validation between bridge and Worker
- [x] Channel state mapping (ARI states → agnostic statuses)
- [x] ARI bridge service (`asterisk-bridge/`) — 2,200+ lines, zero runtime dependencies
  - [x] ARI WebSocket client with reconnection and exponential backoff
  - [x] ARI REST client for channel/bridge/recording/playback operations
  - [x] Webhook sender with HMAC-SHA256 signing (Twilio-compatible form-urlencoded format)
  - [x] Command handler: translates Worker responses to ARI calls (playback, gather, bridge, queue, ring, record)
  - [x] HTTP server with signed endpoints (/command, /ring, /cancel-ringing, /hangup, /recordings)
  - [x] Comprehensive type definitions for ARI events, resources, webhook payloads, and bridge commands
  - [x] Dockerfile for deployment alongside Asterisk
  - [x] Sample Asterisk configs (ari.conf, http.conf, extensions.conf, pjsip.conf)
- [x] Removed "not implemented" warning from admin UI for Asterisk provider

### Epic 36: Telephony Documentation
- [x] Provider comparison page (`telephony-providers.md`) with pricing, features, and setup difficulty tables
- [x] Twilio setup guide (`setup-twilio.md`) — account, webhooks, admin config, WebRTC (API Key + TwiML App)
- [x] SignalWire setup guide (`setup-signalwire.md`) — Space name, LaML compatibility, differences from Twilio
- [x] Vonage setup guide (`setup-vonage.md`) — Application model, NCCO, private key auth
- [x] Plivo setup guide (`setup-plivo.md`) — Auth ID/Token, XML Application, endpoints
- [x] Asterisk setup guide (`setup-asterisk.md`) — server install, SIP trunk, ARI, dialplan, bridge deployment, security
- [x] WebRTC calling guide (`webrtc-calling.md`) — per-provider setup, volunteer preferences, browser compatibility, troubleshooting
- [x] All 7 guides translated to Spanish (es)
- [x] Astro route pages for all docs (7 default + 7 localized = 14 route files)
- [x] Docs index pages updated with guide links (en + es)
- [x] DEVELOPMENT.md — comprehensive development guide (setup, structure, architecture, testing)
- [x] README.md updated with multi-provider support and provider comparison table
- [x] Marketing site grows from 91 to 182 pages
- [x] 131 E2E tests passing (0 regressions)

## 2026-02-11: Marketing Site + Docs (Cloudflare Pages)

### Marketing Site at llamenos-platform.com
- [x] Scaffolded Astro static site in `site/` with Tailwind v4 (via `@tailwindcss/vite`)
- [x] Dark theme design derived from app's oklch palette — bg, card, accent, green/amber/red semantic colors
- [x] **Home page**: Hero with tagline, 6 feature highlight cards, security callout, CTA section
- [x] **Features page**: 7 category sections with accent-bordered headings and left-bordered feature items
- [x] **Security page**: Honest security model with styled collapsible `<details>` elements (chevron indicators, borders, hover states)
- [x] **Docs hub**: Overview with architecture table, roles table, guide cards grid
- [x] **Getting Started guide**: Prerequisites, clone, bootstrap admin, configure secrets, Twilio webhooks, local dev, deploy
- [x] **Admin Guide**: Login, volunteer management, shifts, bans, call settings, custom fields, voice prompts, WebAuthn, audit log, call history
- [x] **Volunteer Guide**: Credentials, login, dashboard, receiving calls, notes, transcription, break toggle, keyboard shortcuts
- [x] Responsive layouts — BaseLayout (marketing pages) + DocsLayout (sidebar + content)
- [x] Mobile hamburger menu, responsive grids, sticky doc sidebar
- [x] Reusable components: Header, Footer, Hero, FeatureCard, LanguageSwitcher
- [x] Cloudflare Pages deployment config (`site/wrangler.jsonc`)
- [x] Root `package.json` scripts: `site:dev`, `site:build`, `site:deploy`
- [x] `.gitignore` updated for `site/dist/`, `site/node_modules/`, `site/.astro/`

### i18n (13 locales, full English + Spanish content)
- [x] Astro Content Collections for all page content (markdown per locale with English fallback)
- [x] `docs` collection: 4 docs pages (index, getting-started, admin-guide, volunteer-guide) in en + es
- [x] `pages` collection: 2 pages (features, security) in en + es
- [x] TypeScript translations for short UI strings (nav, footer, home page components)
- [x] Language switcher on all pages (desktop + mobile) — navigates to locale-prefixed URLs
- [x] 13-locale routing: English at root, other languages prefixed (`/es/`, `/zh/`, etc.)
- [x] Non-translated locales fall back to English content automatically
- [x] Fixed language switcher duplicate ID bug (class + querySelectorAll instead of id + getElementById)
- [x] Fixed Spanish docs double-prefix links (`/es/es/...` -> `/es/...`)
- [x] Translatable `guidesHeading` frontmatter field for docs index
- [x] 91 static HTML pages built across all locales

## 2026-02-09: Sidebar & Shifts UX Improvements

### Volunteer Autocomplete Multi-Select
- [x] Created `VolunteerMultiSelect` component using Popover + Command + Badge chips
- [x] Searchable by name, phone, or pubkey fragment (cmdk fuzzy matching)
- [x] Tag-style display with X to remove, accessible keyboard interaction
- [x] Installed shadcn/ui Popover component (Radix)
- [x] Replaced checkbox-based volunteer selection in ShiftForm and Fallback Group
- [x] i18n: `searchVolunteers`, `noVolunteersFound`, `selectedCount`, `removeVolunteer` in all 13 locales

### Hotline Number in Sidebar
- [x] Exposed `TWILIO_PHONE_NUMBER` via `/config` API endpoint as `hotlineNumber`
- [x] Added `hotlineNumber` to ConfigProvider context
- [x] Displayed hotline number below shift status indicator in sidebar (visible to all authenticated users)

### Sidebar Bottom Section Alignment
- [x] Unified icon sizes to `h-4 w-4` across theme row, command palette, and logout
- [x] Aligned theme switcher row with consistent `px-3 py-2 gap-2` padding matching other rows
- [x] Made LanguageSelect full-width in sidebar via `fullWidth` prop
- [x] Tightened vertical spacing from `space-y-2` to `space-y-1` for compact layout
- [x] All 103 E2E tests passing (0 regressions)

## 2026-02-09: Epic 31 — Custom Note Fields

### Epic 31: Admin-Configurable Custom Fields for Call Notes
- [x] Created `src/shared/types.ts` — shared `CustomFieldDefinition`, `NotePayload`, constants
- [x] Backend: `getCustomFields(role)` / `updateCustomFields(data)` in SessionManager DO
- [x] API routes: `GET/PUT /settings/custom-fields` with role-based visibility filtering
- [x] Client API: `getCustomFields()` / `updateCustomFields(fields)` functions
- [x] Crypto: `encryptNote` now takes `NotePayload` (text + fields), JSON-serialized before encryption
- [x] Crypto: `decryptNote` returns `NotePayload`, with legacy plain-text fallback
- [x] Draft system: extended with `fields` state and `setFieldValue()` callback
- [x] NoteSheet: renders custom fields (text, number, select, checkbox, textarea), validates, encrypts
- [x] Notes page: displays custom field values as badges, preserves fields on edit, includes in export
- [x] Settings page: full CRUD for custom fields — add, edit, delete, reorder (up/down), validation config
- [x] Role-based: `visibleToVolunteers` / `editableByVolunteers` toggles per field
- [x] Validation: required, min/max length, min/max value, max 20 fields, max 50 select options
- [x] E2EE preserved: field values encrypted inside note payload, server only sees opaque ciphertext
- [x] All i18n keys translated in 13 locales (en, es, zh, tl, vi, ar, fr, ht, ko, ru, hi, pt, de)
- [x] 5 new E2E tests: section visibility, add text field, add select field, delete field, deep link
- [x] 101 total E2E tests passing (0 regressions)

## 2026-02-09: Epic 30 — Collapsible Settings Sections

### Epic 30: Collapsible Settings with Deep Links
- [x] Installed shadcn/ui Collapsible component (Radix)
- [x] Created reusable `<SettingsSection>` wrapper with collapsible Card, copy-link button, chevron animation
- [x] Refactored all 10 settings sections to use `<SettingsSection>`
- [x] Profile section expanded by default, all others collapsed
- [x] Multiple sections can be open simultaneously (not single-accordion)
- [x] URL search param `?section=id` deep-links to any section (auto-expand + scroll)
- [x] TanStack Router `validateSearch` for type-safe section param
- [x] Copy link button on each section header (copies shareable URL, auto-clears clipboard after 30s)
- [x] Smooth height animation via Radix Collapsible + tw-animate-css
- [x] All strings translated in 13 locales
- [x] 4 new E2E tests: deep linking, collapse/expand, multi-open, copy-link button
- [x] Updated existing E2E tests to expand sections before interacting with content
- [x] 96 total E2E tests passing

## 2026-02-07: Initial MVP Build

### Epic 1: Project Foundation
- [x] Vite + TanStack Router SPA with file-based routing
- [x] Tailwind CSS v4 with dark theme
- [x] i18n with English + Spanish translations
- [x] WebSocket keypair authentication
- [x] XChaCha20-Poly1305 note encryption
- [x] WebSocket real-time updates
- [x] Cloudflare Workers + Durable Objects backend
- [x] CLI admin bootstrap script

### Epic 2: Admin System
- [x] Volunteer management (CRUD, role assignment)
- [x] Client-side keypair generation for new volunteers
- [x] Shift scheduling with recurring days and time ranges
- [x] Fallback ring group configuration
- [x] Ban list management (single + bulk import)
- [x] Audit log viewer with pagination
- [x] Settings page (spam mitigation, transcription)

### Epic 3: Telephony
- [x] TelephonyAdapter interface (provider-agnostic)
- [x] Twilio implementation (incoming calls, parallel ringing, CAPTCHA)
- [x] Voice CAPTCHA with randomized 4-digit input
- [x] Sliding-window rate limiting per phone number
- [x] Ban check on incoming calls
- [x] Shift-based routing with fallback group
- [x] Call queue with hold music

### Epic 4: Volunteer Experience
- [x] Real-time dashboard with call status cards
- [x] Incoming call UI with answer button
- [x] Active call panel with timer and note-taking
- [x] Spam reporting from active call
- [x] Notes page with call grouping
- [x] Client-side note encryption/decryption

### Epic 5: Transcription
- [x] Cloudflare Workers AI (Whisper) integration
- [x] Admin toggle for global transcription enable/disable
- [x] Volunteer toggle for per-user transcription preference
- [x] Post-call transcript viewing in notes
- [x] Post-call transcript editing by volunteers

### Epic 6: UI Polish & Quality
- [x] shadcn/ui component system (button, card, badge, dialog, input, label, select, switch, separator)
- [x] Toast notification system (success, error, info)
- [x] Loading skeletons on all data pages
- [x] Call history page for admins with pagination
- [x] Profile setup flow (language selection on first login)
- [x] Volunteer on-break availability toggle (pause calls without leaving shift)
- [x] Server-side E.164 phone number validation
- [x] Session expiry with 5-minute token window (replay attack prevention)

### Epic 7: E2EE for Transcriptions
- [x] ECIES encryption using ephemeral ECDH with secp256k1
- [x] Server-side: encrypt transcription for volunteer's pubkey + admin's pubkey
- [x] Client-side: decrypt transcription via ECDH shared secret
- [x] XChaCha20-Poly1305 symmetric encryption with domain-separated key derivation
- [x] Ephemeral private key discarded immediately (forward secrecy)
- [x] Dual encryption: volunteer copy + admin copy for independent decryption
- [x] Backward compatibility with legacy plaintext transcriptions

### Epic 8: Call History Search/Filter
- [x] TanStack Router validateSearch for URL-persisted search params
- [x] Search by phone number or volunteer pubkey
- [x] Date range filtering (from/to)
- [x] Backend filtering in CallRouter DO

### Epic 9: Security Audit & Hardening
- [x] Twilio webhook signature validation (HMAC-SHA1)
- [x] Auth rate limiting (10 attempts/min per IP)
- [x] CORS restricted to same-origin (dev: localhost:5173)
- [x] Content-Security-Policy header added
- [x] Caller phone number redacted for non-admin users
- [x] Path traversal protection via extractPathParam helper
- [x] Confirmation dialogs replaced browser confirm() (ConfirmDialog component)

### Epic 10: E2E Tests
- [x] Smoke test: app loads, shows login, rejects invalid nsec
- [x] Admin flow: login, nav, volunteer CRUD, shifts, bans, audit log, settings, call history, notes, i18n, logout
- [x] Updated tests for ConfirmDialog (replaced window.confirm)

## 2026-02-08: Production Quality Polish

### Epic 11: Mobile Responsive
- [x] Collapsible sidebar with hamburger menu on mobile
- [x] Responsive grid forms (1-col mobile, 2-col desktop)
- [x] Adaptive data row layouts with flex-wrap
- [x] Responsive search form (stacked on mobile)
- [x] Mobile top bar with hotline name
- [x] Close sidebar on navigation

### Epic 12: Accessibility (A11y)
- [x] Skip-to-content link
- [x] aria-labels on all icon-only buttons
- [x] aria-pressed on toggle buttons
- [x] Fixed heading hierarchy (h1 per page)
- [x] HTML lang and dir (RTL) sync on language change
- [x] Toast role="alert" for errors, role="status" for success
- [x] a11y i18n namespace in all 13 locales

### Epic 13: Command Palette
- [x] Cmd/Ctrl+K global keyboard shortcut
- [x] Navigation, actions, theme, and language command groups
- [x] Admin-only navigation commands filtered
- [x] Sidebar trigger button with keyboard shortcut hint
- [x] commandPalette i18n namespace in all 13 locales

### Epic 14: E2E Test Expansion
- [x] Shared test helpers (login, create volunteer, profile setup)
- [x] 56 tests across 8 files (up from 14)
- [x] Volunteer flow: login, profile setup, limited nav, break toggle, admin page guards
- [x] Notes CRUD: create, view, edit, cancel, grouping
- [x] Auth guards: redirects, session persistence, API 403
- [x] Theme: dark/light/system switching, persistence
- [x] Form validation: phone format, E.164, bulk import
- [x] Responsive: mobile hamburger, no horizontal overflow
- [x] Mobile-chromium Playwright project for responsive tests

## 2026-02-08: UX / Design / Product Review

### Comprehensive Audit
- [x] Playwright screenshot audit of every page (login, dashboard, notes, shifts, volunteers, bans, calls, audit, settings)
- [x] Desktop (1280px) and mobile (375px) viewport testing
- [x] Light mode, dark mode, and system theme testing
- [x] Multilingual testing (English, Spanish, Arabic RTL)
- [x] Error state testing (invalid login)
- [x] All three persona flows reviewed (Caller, Volunteer, Admin)

### Findings Documented
- [x] 4 critical bugs identified (C1-C4): broken light mode, dead metric, duplicate identities, deployment gap
- [x] 6 high-priority UX issues (H1-H6): card wrapping, notes UX, missing translations, no notifications, no status dashboard, copy-paste bug
- [x] 8 medium-priority issues (M1-M8): tooltips, audit formatting, empty states, double-negative toggle
- [x] 8 low-priority issues (L1-L8): keyboard shortcuts, component consistency, pagination

### Epics Created
- [x] Epic 15: Light Mode & Design System Cleanup
- [x] Epic 16: Real-Time Volunteer Status & Admin Dashboard
- [x] Epic 17: Notification System
- [x] Epic 18: Notes & Search Improvements

### Backlog Updated
- [x] NEXT_BACKLOG.md reorganized with Critical/High/Medium/Low tiers and reference IDs

## 2026-02-08: Epics 15–18 & Full Bug Sweep

### Epic 15: Light Mode & Design System
- [x] Fixed hardcoded dark-mode colors across all pages (dashboard, notes, shifts, volunteers, bans, calls, audit, settings)
- [x] Dual light/dark theme support with proper CSS variable usage
- [x] Login button color fix for light mode (M3)

### Epic 16: Volunteer Status Dashboard & Presence
- [x] Backend presence tracking in SessionManager DO (online/offline/on-break per volunteer)
- [x] Real-time status updates via WebSocket broadcast
- [x] Admin dashboard card showing volunteer online/offline/on-break counts
- [x] Volunteer status indicators in admin volunteer list

### Epic 17: Notification System
- [x] Web Audio API ringtone for incoming calls (with play/pause toggle)
- [x] Browser push notifications (with permission request flow)
- [x] Tab title flashing on incoming call
- [x] Settings toggles for ringtone and browser notifications
- [x] Notification preferences persisted per-session

### Epic 18: Notes Search, Pagination & Call ID UX
- [x] URL-persisted search via TanStack Router validateSearch
- [x] Full-text search across note content
- [x] Pagination with configurable page size
- [x] Call ID selection from dropdown or manual entry
- [x] GDPR-compliant data export (JSON download)

### Bug Fixes
- [x] **C1** Fixed hardcoded dark-mode colors (Epic 15)
- [x] **C2** Fixed dead "Active Calls" metric — wired to real call data
- [x] **C3** Fixed duplicate volunteer identities — dedup by pubkey
- [x] **H1** Fixed card content wrapping/overflow on small viewports
- [x] **H3** Fixed notes UX — added search, pagination, call ID picker
- [x] **H6** Fixed missing translations — 20 new keys added to all 13 locales (238 keys parity)
- [x] **M1–M8** Medium priority items (tooltips, audit formatting, empty states, toggle labels, etc.)
- [x] **L4** Changed "Get Started" to "Complete Setup" in profile flow
- [x] **L5** Added keyboard shortcuts section to command palette

### Infrastructure & Test Fixes
- [x] CardTitle component changed from `<div>` to `<h3>` for proper heading semantics (a11y)
- [x] Playwright responsive tests fixed (`test.use()` moved to top-level)
- [x] Admin flow test fixed (strict mode violation on `getByText('Admin')`)
- [x] Test helper `completeProfileSetup` updated for new button text
- [x] Playwright config: explicit worker count (4 local, 1 CI)
- [x] i18n: 20 new keys translated across 12 locales (238 keys parity across all 13 files)
- [x] Deployed to Cloudflare Workers

## 2026-02-08: Epics 24–27 — UX & Polish Round

### Epic 24: Shift & Call Status Awareness
- [x] Shift status hook (`useShiftStatus`) — checks current/next shift for logged-in user
- [x] Sidebar shift indicator — shows current shift name + end time, or next shift day/time
- [x] In-call indicator in sidebar — shows animated pulse when volunteer is on a call
- [x] Dashboard "Calls Today" metric wired to real API data

### Epic 25: Command Palette Enhancements
- [x] Quick Note action — create encrypted note directly from command palette
- [x] Search shortcuts — type in palette to search notes or calls
- [x] Admin-only search filtering (call search only visible to admins)

### Epic 26: Custom IVR Audio Recording
- [x] Admin voice prompt recording via MediaRecorder API (max 60s per prompt)
- [x] IVR audio CRUD API (upload, list, delete, stream)
- [x] Backend storage in SessionManager DO (`ivr-audio:*` keys)
- [x] `sayOrPlay()` TwiML helper — uses `<Play>` for custom audio, falls back to `<Say>` TTS
- [x] `AudioUrlMap` type in TelephonyAdapter interface
- [x] Voice Prompts admin settings card with per-language recording grid
- [x] Audit events for IVR audio upload/delete

### Epic 27: Remaining Polish & Backlog Items
- [x] Replaced all raw `<select>` elements with shadcn Select (notes, volunteers, note-sheet)
- [x] Toast dismiss button for manual close
- [x] Keyboard shortcuts help dialog (`?` key + command palette action)
- [x] Confirmation dialogs for admin settings toggles (transcription, CAPTCHA, rate limiting)
- [x] Note draft auto-save with `useDraft` hook and draft indicator
- [x] `shortcuts`, `confirm`, `draftSaved` i18n keys across all 13 locales

## 2026-02-09: Security Hardening & Voicemail

### Security Hardening (from deep audit — round 1)
- [x] Constant-time comparison for auth tokens and Twilio webhook signatures
- [x] WebSocket auth moved from URL query params to `Sec-WebSocket-Protocol` header
- [x] CSP `wss:` restricted to same host only
- [x] HSTS header added (max-age=63072000, includeSubDomains, preload)
- [x] Caller phone numbers redacted in all WebSocket broadcasts
- [x] Browser notifications use generic text (no caller info on lock screens)
- [x] Service worker API caching removed (sensitive data protection)
- [x] PWA manifest uses generic name "Hotline" (not "Llámenos")
- [x] Audit logs include IP/country/UA metadata
- [x] Console.logs removed from production paths
- [x] Deployment URL removed from all documentation

### Epic 28: Voicemail Fallback
- [x] `handleVoicemail()` in TwilioAdapter with `<Record>` TwiML (max 120s)
- [x] Voicemail voice prompts in all 13 languages
- [x] Queue timeout: `<Leave/>` after 90 seconds via QueueTime check in wait music
- [x] `<Enqueue action=...>` routes to voicemail on queue exit (leave/queue-full/error)
- [x] CallRecord type expanded: `'unanswered'` status + `hasVoicemail` field
- [x] CallRouter DO: `handleVoicemailLeft()` — moves call to history, broadcasts `voicemail:new`
- [x] Voicemail transcription via Workers AI Whisper, encrypted for admin (ECIES)
- [x] Voicemail thank-you message in 13 languages after recording
- [x] Frontend: unanswered badge + voicemail indicator in call history
- [x] `voicemailReceived` audit event
- [x] i18n: `unanswered`, `hasVoicemail`, `voicemailReceived`, `voicemailPrompt` keys in all 13 locales

### Security Hardening (from deep audit — round 2)
- [x] **CRITICAL**: Auth tokens replaced with BIP-340 Schnorr signatures (was SHA-256 hash — auth bypass)
- [x] WebSocket subprotocol encoding fixed to base64url (no `=` / `/` chars that crash WS handshake)
- [x] WebSocket server echoes `Sec-WebSocket-Protocol: llamenos-auth` header (WS spec compliance)
- [x] Caller PII removed from notification function signature (defense in depth)
- [x] Encrypted draft notes cleaned from localStorage on logout
- [x] Profile settings backend accepts name + phone updates (admin can set phone to receive calls)

## 2026-02-09: Epic 29 — Configurable Settings, WebAuthn & Backlog Completion

### Feature 1: Configurable Call Settings
- [x] Queue timeout configurable (30-300s, default 90s) — admin settings UI + backend
- [x] Voicemail max duration configurable (30-300s, default 120s)
- [x] CallSettings type + DO storage + PATCH/GET API routes
- [x] TwilioAdapter uses configurable values for queue timeout & voicemail recording
- [x] i18n: `callSettings.*` keys in all 13 locales

### Feature 2: WebAuthn Passkeys
- [x] `@simplewebauthn/server` + `@simplewebauthn/browser` integration
- [x] Server-side WebAuthn lib (registration + authentication flows)
- [x] Dual auth: `Authorization: Bearer {schnorr}` and `Authorization: Session {token}`
- [x] WebAuthn credential CRUD in SessionManager DO
- [x] Server session management (256-bit random tokens, 8-hour expiry)
- [x] Single-use challenges with 5-minute TTL
- [x] Login page "Sign in with passkey" button
- [x] Settings page credential management (list, register, delete)
- [x] Admin "Passkey Policy" card (require for admins/volunteers)
- [x] WebSocket auth extended for session tokens
- [x] `/auth/me` returns `webauthnRequired` + `webauthnRegistered`
- [x] i18n: `webauthn.*` keys (18 keys) in all 13 locales

### Feature 3: Session Expiry UX
- [x] Idle tracking (30s interval checks for 4-minute idle)
- [x] Warning toast "Session expiring soon" with "Stay logged in" button
- [x] Non-dismissible expired dialog with reconnect option
- [x] Session token auto-renewal via `getMe()` call
- [x] i18n: `session.*` keys in all 13 locales

### Feature 4: Phone Input with Live E.164 Validation
- [x] `PhoneInput` component with auto-prepend `+`, live validation, color-coded borders
- [x] Replaced in settings, volunteers (add + invite), and bans pages
- [x] i18n: `phone.*` keys in all 13 locales

### Feature 5: E2E Test Isolation
- [x] `resetTestState()` helper in `tests/helpers.ts`
- [x] `test.beforeEach` reset in all mutating test files
- [x] `workers: 1` in playwright.config.ts for serial execution
- [x] Test reset endpoints in all 3 DOs (Session, Shift, CallRouter)

### Security Hardening (Audit Round 3)
- [x] Hash caller phone numbers before DO storage (SHA-256 with domain separator)
- [x] ~~Hash phone numbers in ban list~~ (reverted — admin needs original numbers for ban management)
- [x] Move rate limiting from in-memory Map to DO storage (persists across Worker restarts)
- [x] Guard Twilio webhook validation — only skip when BOTH dev mode AND localhost
- [x] Rate-limit invite validation endpoint (10 req/min per IP)
- [x] Hash IP addresses in audit log entries (truncated SHA-256)
- [x] Stop broadcasting volunteer pubkeys in presence updates (anonymous counts only)
- [x] Remove plaintext pubkey from encrypted key-store localStorage (hashed with domain separator)
- [x] Add notes export encryption (XChaCha20-Poly1305 with user's key, .enc format)
- [x] Auto-clear clipboard after 30s for nsec/invite link copy

## Cross-Platform BDD Runner Integration (Epics 223-226)

### Epic 223: Cross-Platform BDD Specification Framework
- [x] Platform tag system (@android @ios @desktop) for feature files
- [x] Shared step vocabulary (STEP_VOCABULARY.md)
- [x] Multi-platform validate-coverage.ts with tag-aware validation
- [x] Committed: `cfe3957`

### Epic 224: Android Cucumber-Android Migration
- [x] cucumber-android 7.18.1 + Hilt integration
- [x] CucumberHiltRunner with @CucumberOptions tag filtering
- [x] 19 step definition classes (Base, Compose holder, Activity holder, Hilt hooks + 14 domain)
- [x] All 25 old e2e test classes deleted, replaced with Cucumber step definitions
- [x] Gradle copyFeatureFiles task copies shared features to androidTest assets
- [x] assembleDebugAndroidTest, lintDebug, testDebugUnitTest all pass
- [x] Committed: `f345205`

### Epic 225: Desktop BDD Feature Specifications
- [x] 23 new cross-platform feature files in shared directories
- [x] 7 desktop-only feature files in desktop/ subdirectory
- [x] 48 total feature files, 260 desktop scenarios, 222 total cross-platform scenarios
- [x] Features organized by domain: auth, admin, bans, notes, messaging, settings, shifts, crypto

### Epic 226: Playwright-BDD Integration
- [x] playwright-bdd v8.4.2 installed and configured
- [x] Hybrid playwright.config.ts: BDD project coexists with 358 existing .spec.ts tests
- [x] 26 step definition files with 607 step definitions
- [x] bddgen generates 47 spec files (224 BDD tests) with zero missing steps
- [x] tests/steps/fixtures.ts: createBdd() for type-safe Given/When/Then exports
- [x] Committed: `00f37cd`

## Production Readiness Epics 276-300 (5 Tracks)

### Track 1: Infrastructure & Self-Hosting (E276-E280)
- [x] Ansible deployment playbook with Docker Compose, PostgreSQL, RustFS, nginx, Certbot
- [x] Kubernetes/Helm chart with StatefulSet, PV claims, Ingress, HPA
- [x] Node.js platform adapter with PostgreSQL shim for all 7 DOs
- [x] Monitoring stack: Prometheus, Grafana, Loki, 3 dashboards, 12 alert rules
- [x] Auto-backup with S3/RustFS, point-in-time recovery, integrity verification

### Track 2: Data Safety (E281-E285)
- [x] Storage sharding: per-entry keys with prefix scans (DO storage)
- [x] Soft-delete lifecycle: 30-day retention with `state` field
- [x] Conflict resolution: vector clocks for concurrent DO edits
- [x] Data export: admin + volunteer encrypted ZIP exports with NaCl box
- [x] Storage optimization: LRU cache, 100-item batch writes, alarm-based cleanup

### Track 3: Compliance & Legal (E286-E287)
- [x] GDPR pipeline: automated data subject access requests, anonymization, audit trail
- [x] Legal framework docs: ToS, privacy policy, DPA, cookie policy (13 locales)

### Track 4: Client Hardening (E288-E293)
- [x] Input validation: Zod schemas for all API routes, OWASP sanitization
- [x] Rate limiting: token bucket per-IP, per-user, per-endpoint
- [x] API versioning: `X-Api-Version` header, min/current version enforcement
- [x] Offline mode: IndexedDB queue, CRDT merge, optimistic UI, relay reconnect
- [x] Accessibility audit: WCAG 2.1 AA, ARIA roles, keyboard navigation, screen reader
- [x] Crash reporting: GlitchTip (self-hosted Sentry), 3 platforms, PII stripping

### Track 5: Operational Sustainability (E294-E300)
- [x] E294: Operator alerting — cron health checks (7 signals), ntfy/gotify/email/webhook
- [x] E295: System health dashboard — Worker route + desktop admin page + 25 i18n keys
- [x] E296: Load testing — k6 scripts (4 scenarios), capacity planning doc, CI workflow
- [x] E297: Security update automation — Trivy, bun/cargo audit, automated OS updates
- [x] E298: DR drills — Ansible playbook for full-stack restore validation, 5 scenarios
- [x] E299: Operator handbook — consolidated handbook, troubleshooting trees
- [x] E300: Mobile admin feature parity — report categories, telephony, call/IVR/spam settings, system health, recording playback on iOS + Android
