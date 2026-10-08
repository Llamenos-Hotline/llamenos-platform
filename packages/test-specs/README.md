# @llamenos/test-specs

Cross-platform BDD test specifications using Gherkin `.feature` files.

See [`STRATEGY.md`](./STRATEGY.md) for the ratified all-BDD testing
strategy (BDD specs as source of truth, platform step definitions,
`tools/validate-coverage.ts` as the coverage gate, and the silent-pass
step audit in `tools/audit-silent-steps.ts`).

## Approach

**Behavioral Contracts** -- Feature files define *what the system does*, not what the UI looks like. Every scenario tests state changes, data correctness, or permission enforcement. Shallow UI-existence checks (`Then I should see the "foo" element`) are not allowed.

Feature files are organized into behavior-focused tiers that naturally group related functionality across platforms and backend.

## Directory Structure

```
features/
  core/               # Cross-cutting behavioral contracts
    auth-login.feature       # Authentication, PIN, key import, permissions
    call-routing.feature     # Call lifecycle, routing, history, simulation
    contacts.feature         # Contact list and timeline
    dashboard.feature        # Dashboard display, quick actions, shift status
    messaging-flow.feature   # Conversation routing, assignment, E2EE
    note-encryption.feature  # Note CRUD, encryption, threads, search
    reports.feature          # Report lifecycle (create, claim, close)
    volunteer-lifecycle.feature  # Volunteer CRUD, roles, profile
  admin/              # Admin-only management features
    audit-log.feature        # Audit log + hash chain verification
    ban-management.feature   # Ban list CRUD + bulk import
    blast-campaign.feature   # Blast messaging
    custom-fields.feature    # Custom note field administration
    settings.feature         # Hub settings, user settings, theme, device link
    shift-management.feature # Shift CRUD, clock in/out, scheduling
  security/           # Security and cryptography
    crypto-interop.feature   # Test vectors, keypair gen, PIN encryption
    do-routing.feature       # Durable Object router validation
    e2ee-roundtrip.feature   # End-to-end encryption roundtrips
    network-security.feature # HTTPS, relay URL, SAS, audit coverage
    session-management.feature # Session TTL, revocation, multi-device
  platform/           # Platform-specific features
    desktop/          # Desktop-only (Tauri/Playwright)
    ios/              # iOS-only (XCUITest)
    android/          # Android-only (Cucumber)
```

## Tagging Rules

Every scenario MUST have platform tags specifying where it runs:

```gherkin
@backend              # API-only (no UI) -- runs via Playwright APIRequestContext
@desktop              # Desktop Playwright-BDD
@ios                  # iOS XCUITest
@android              # Android Cucumber
@smoke                # Quick CI subset
@regression           # Full regression suite
@security             # Security-specific tests
@crypto               # Crypto verification tests
@requires-camera      # Requires device camera
@requires-network     # Requires API connectivity
@offline              # Works without network
@wip                  # Not yet implemented -- excluded from CI
@simulation           # Uses test simulation endpoints
@e2e                  # End-to-end integration
```

`@backend` scenarios use ONLY API assertions -- no page interactions, no DOM checks.

Scenarios inherit Feature-level tags. A Feature tagged `@backend @desktop @ios @android` runs on all platforms; individual scenarios can add/override tags.

## Naming Conventions

| Item | Convention | Example |
|------|-----------|---------|
| Feature file | `kebab-case.feature` | `call-routing.feature` |
| Scenario title | Human-readable sentence | `Completed call appears in history with correct metadata` |
| Android test method | `camelCase` | `completedCallAppearsInHistoryWithCorrectMetadata()` |
| iOS test method | `camelCase` with `test` prefix | `testCompletedCallAppearsInHistoryWithCorrectMetadata()` |

## Adding a New Feature

1. Place the `.feature` file in the appropriate tier (`core/`, `admin/`, `security/`, or `platform/`)
2. Tag every scenario with the platforms it should run on
3. Write scenarios that test behavior, not UI existence
4. Implement step definitions: Desktop (`tests/steps/`), Android (`apps/android/.../steps/`), iOS (`Tests/E2E/`)
5. Run `bun run test-specs:validate` to verify coverage

## CI Validation

```bash
bun run test-specs:validate           # Validates all platform coverage
bun run test-specs:validate --platform android
bun run test-specs:validate --platform desktop
bun run test-specs:validate --platform ios
bun run test-specs:validate --platform all
```

### Silent-pass step audit

`validate-coverage.ts` proves a step is *bound*; it does not prove the
step's body does anything (see its own doc comment). `audit-silent-steps.ts`
checks that instead — see [`STRATEGY.md`](./STRATEGY.md) for the full
rationale and the current ratchet baseline.

```bash
bun packages/test-specs/tools/audit-silent-steps.ts
bun packages/test-specs/tools/audit-silent-steps.ts --platform desktop-backend
bun packages/test-specs/tools/audit-silent-steps.ts --platform android
```
