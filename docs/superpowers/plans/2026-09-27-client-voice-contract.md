# Client Voice — Phase 0: the shared contract and registration correctness

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give all three clients one generated voice contract and a registration path that is correct end to end, while the server honestly declines to issue credentials until a home realm exists.

**Architecture:** A new `packages/protocol/schemas/voice.ts` becomes the single source of truth for SIP credentials, call state, registration state and capabilities, generated to TypeScript, Swift and Kotlin. The three disagreeing shapes in use today are replaced by one, and the endpoint gains the specification entry it has never had. Clients gain the ability to register every hub they are on shift for, with a real `AuthInfo`; the server returns an empty registration set with `inAppAudio: false` until Phase 1 lands the realm, so no volunteer ever registers at a telephony vendor with a shared credential.

**Tech Stack:** Zod 4 → `toJSONSchema()` → quicktype (TS/Swift/Kotlin); Hono + Bun (server); React + TanStack (desktop webview); SwiftUI (iOS); Kotlin/Compose + Hilt (Android); vitest (unit), Playwright (desktop E2E), backend BDD (Gherkin + `tests/steps/`).

**Spec:** `docs/superpowers/specs/2026-09-27-client-voice-architecture-design.md`

---

## Scope of this plan, and what follows it

The spec describes six phases across three clients and the infrastructure under them. **This plan implements Phase 0 only**, because Phase 0 is the one
tranche that is independently valuable, unblocked, and true regardless of how the architecture
questions resolve. Planning the rest now would be false precision: Phase 3 depends on what the
Phase 2 spike measures, and writing TDD steps for a Rust liblinphone binding before anyone has
compiled one produces fiction.

| Plan | Covers | Entry criteria |
|---|---|---|
| **This plan** | Spec §6, §12, and the Phase 0 list in §18 | none — start now |
| Plan 2 — per-volunteer identities and trunks on the PBX | Spec §5 (Layer 2), §7, §8, §11 (server side), Phase 1. Smaller than it first looked: the ARI dynamic-config client, the memory-wizard storage policy and the volunteer dialplan context already exist and are unwired. Covers the hub-provider → trunk mapping and the teardown that does not exist today. | this plan merged |
| Plan 2b — the relay | Phase 1b: ephemeral credentials, TLS listener, relay port range, a configuration-management role where none exists | independent of Plan 2; both needed before audio is enabled |
| Plan 3 — desktop spike | Phase 2: bindgen to one answered call on Linux | **needs the first slice of Plan 2** — the PBX has transports and no endpoints today, so there is nothing to register against |
| Plan 4 — desktop voice and workspace | Spec §14, §15, §16, §17; Phase 3 | Plan 3 answered its question; §16's performance gate measured |
| Plan 5 — mobile platform integration | Phase 4, realistically one plan per platform | Plan 2 merged, so there is something to register against |
| Plan 6 — capacity | Spec §10, Phase 5 | Plan 4 merged, so there is traffic to measure |

Each gets its own spec review and its own plan. Do not start them from this document.

## Global Constraints

Copied from the spec and from `CLAUDE.md`; every task's requirements implicitly include these.

- **No implementation of the realm in this plan.** The server must return an **empty** registration
  array and `inAppAudio: false`. Do not point a client at a vendor SIP domain. Spec §18, Phase 0
  note — this is the sequencing constraint that keeps a theoretical leak from becoming a real one.
- **This plan does not fix the §1.1 security defect; it makes it unreachable.** Per-device minting
  is Plan 2. Do not describe it otherwise in a commit message, PR body or release note.
- **No transcription work, no call workspace, no Rust.** Those are Plan 4 (spec §15–§17). This plan
  touches no `apps/desktop/src/*.rs` and adds no IPC command.
- **No PBX work.** Provisioning per-volunteer endpoints and trunks is Plan 2. This plan touches
  nothing under `sip-bridge/` or `deploy/`, and adds no caller for `configureDynamic` /
  `deleteDynamic`.
- **Do not touch `apps/worker/telephony/` adapters.** The eight `TelephonyAdapter` implementations
  and their IVR dialects are unaffected by this architecture (spec §5, Layer 3). "One common SIP
  interface" is not licence to collapse them.
- **Do not delete `apps/worker/telephony/sip-tokens.ts`.** Phase 1 still needs its per-provider
  knowledge for trunking. Stop calling it from the client-credential path; leave the module.
- **TypeScript strict, no `any`.** `bun run typecheck` and `bunx eslint` must stay clean.
- **Zod: `.optional().default(v)`, never bare `.default(v)`.** Bare defaults emit wrong JSON Schema
  in Zod 4 and break Kotlin/Swift codegen defaults.
- **Generated output is gitignored.** Never stage `packages/protocol/generated/`,
  `packages/i18n/generated/`, `apps/ios/Resources/Localizable/`, or the Android `strings.xml` /
  `I18n.kt` outputs. The `block-generated-files` pre-commit job will reject the commit.
- **All user-facing strings go through `packages/i18n`.** Never add a string directly to a platform
  file. Use the **`softphone.*`** namespace — **not** `voice.*`, which is caller-facing IVR text fed
  to text-to-speech (spec §20).
- **Never gate incoming-call handling on active hub state.** Background push handlers must never
  call `setActiveHub`; only an explicit notification tap or the app-unlocked answer path may.
- **No silent catches in the voice path.** Four of them are why nobody noticed registration has
  never worked. Errors surface as state the UI can render.
- **Run `bun run codegen` after any schema change**, before typecheck. The `codegen-freshness`
  pre-commit job runs `bun run codegen:check` on `packages/protocol/schemas/*.ts`.
- **Rebase onto #1088 before starting Tasks 5 and 6** — it edits `AppState.swift` (where
  `LinphoneService` is constructed) and `AppModule.kt`.

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `packages/protocol/schemas/voice.ts` | The whole voice contract. One file, because these types only make sense together and change together. |
| `packages/test-specs/features/core/voice-registration.feature` | Behavioural coverage for the credential endpoint. There is none today. |
| `tests/steps/backend/voice-registration.steps.ts` | Step definitions for the above. |

**Modified**

| File | Change |
|---|---|
| `packages/protocol/schemas/index.ts` | Add `export * from './voice'`. |
| `packages/protocol/schemas/webrtc.ts` | Delete `sipTokenResponseSchema` and `webrtcTokenResponseSchema`; keep `telephonyStatusResponseSchema`. |
| `packages/protocol/tools/schema-registry.ts` | Add the six bare enums to `EXCLUDED_SCHEMAS`. |
| `apps/worker/routes/webrtc.ts` | `/sip-token` returns the new contract; `/sip-status` reports capabilities. |
| `src/client/lib/webrtc.ts` | `WebRtcState` → generated `VoiceCallState`; provider gating → capability. |
| `src/client/lib/api.ts` | Replace `getWebRtcToken` / `getWebRtcStatus` with `getVoiceRegistrations(): Promise<VoiceRegistrationSet>` — the same name iOS and Android use, so the three clients read alike. |
| `src/client/lib/in-app-audio.ts` | Delete. Its one export is replaced by server-declared capability. |
| `src/client/lib/call-state.ts` | Fold into the voice store so there is one notion of call state. |
| `src/client/components/webrtc-call.tsx` | Render the new state set and the unavailable reason. |
| `src/client/components/setup/InAppAudioNotice.tsx`, `setup/VoiceSmsProviderForm.tsx`, `admin-settings/telephony-provider-section.tsx`, `routes/settings.tsx` | Drop the `supportsInAppAudio` import. |
| `apps/ios/Sources/Services/LinphoneService.swift` | Delete the hand-written struct; create `AuthInfo`; register every hub in the set; bound the pending map; stop swallowing. |
| `apps/ios/Sources/Services/APIService.swift` | Correct the endpoint path; stop forcing snake-case decoding on it. |
| `apps/ios/Sources/ViewModels/ShiftsViewModel.swift` | Register every hub in the returned set; surface failures. |
| `apps/ios/Sources/App/LlamenosApp.swift` | `setActiveHub` only on tap / answer. |
| `apps/android/.../telephony/LinphoneService.kt` | Delete the hand-written struct; create `AuthInfo`; stop swallowing; expose registration state. |
| `apps/android/.../ui/shifts/ShiftsViewModel.kt` | Fetch the credential set and register every hub in it. |
| `apps/android/.../service/PushNotificationRouter.kt`, `PushService.kt` | One payload spelling. |
| `packages/i18n/locales/*.json` | The `softphone.*` namespace, all locales. |
| `docs/protocol/PROTOCOL.md` | **Add** a section for the credential endpoint, which the document has never covered. §4.18 describes `webrtc-token` and is correct; leave it. |

---

### Task 1: The voice contract schema

**Files:**
- Create: `packages/protocol/schemas/voice.ts`
- Modify: `packages/protocol/schemas/index.ts`
- Modify: `packages/protocol/schemas/webrtc.ts`
- Modify: `packages/protocol/tools/schema-registry.ts` (`EXCLUDED_SCHEMAS`)
- Test: `packages/protocol/__tests__/voice-schema.test.ts`

**Interfaces:**
- Produces: `voiceRegistrationCredentialSchema`, `voiceRegistrationSetSchema`,
  `voiceRegistrationStateSchema`, `voiceHubRegistrationSchema`, `voiceCallStateSchema`,
  `voiceUnavailableReasonSchema`, `audioRouteSchema`, `voiceCapabilitiesSchema`,
  `voiceCallHandoffSchema`, `voiceCallSnapshotSchema`; generated types `VoiceRegistrationSet`,
  `VoiceRegistrationCredential`, `VoiceCapabilities`, `VoiceCallState`, `VoiceCallSnapshot`,
  `VoiceCallHandoff`, `VoiceHubRegistration`.

Two decisions this task locks in, so later tasks do not relitigate them:

**Why the four enums go in `EXCLUDED_SCHEMAS`.** The registry takes every export ending in `Schema`
and hands it to quicktype. A bare `z.enum` produces a standalone type quicktype renders poorly and
inconsistently across Swift and Kotlin. The existing registry already excludes "bare enum building
blocks" for this reason. Excluding them does **not** remove the enum values from the generated
output — they are still emitted as nested enums wherever an object schema embeds them, which is
everywhere they are used.

**Why `registrations` is an array and not a map keyed by `hubId`.** An array makes "I handled all of
them" a length check, which a test can assert (Task 5 and Task 6 both make exactly that assertion).
A map makes it a lookup, which a single-hub implementation satisfies without noticing. Note what
this does **not** do: it does not make a single-hub implementation fail to compile —
`registrations[0]` type-checks fine. The guarantee comes from the test, not the type.

- [ ] **Step 1: Write the failing test**

```ts
// packages/protocol/__tests__/voice-schema.test.ts
import { describe, it, expect } from 'vitest'
import {
  voiceRegistrationSetSchema,
  voiceRegistrationCredentialSchema,
  voiceCapabilitiesSchema,
  voiceCallSnapshotSchema,
} from '../schemas/voice'

const credential = {
  hubId: '11111111-1111-4111-8111-111111111111',
  realm: 'example.invalid',
  domain: 'example.invalid',
  transport: 'wss' as const,
  username: 'device-abc',
  password: 'secret',
  expiresAt: '2026-09-27T12:00:00Z',
  mediaEncryption: 'dtls-srtp' as const,
}

describe('voice contract', () => {
  it('accepts a complete registration set', () => {
    const parsed = voiceRegistrationSetSchema.parse({
      registrations: [credential],
      capabilities: {
        inAppAudio: true, hold: true, dtmf: true,
        audioRouteSelection: false, deviceSelection: true, platformCallUi: false,
      },
    })
    expect(parsed.registrations).toHaveLength(1)
  })

  it('accepts an empty registration set — the Phase 0 server response', () => {
    const parsed = voiceRegistrationSetSchema.parse({
      registrations: [],
      capabilities: {
        inAppAudio: false, hold: false, dtmf: false,
        audioRouteSelection: false, deviceSelection: false, platformCallUi: false,
      },
      unavailableReason: 'not-configured',
    })
    expect(parsed.registrations).toEqual([])
    expect(parsed.capabilities.inAppAudio).toBe(false)
  })

  it('defaults iceServers to an empty array rather than undefined', () => {
    expect(voiceRegistrationCredentialSchema.parse(credential).iceServers).toEqual([])
  })

  it('rejects a transport the client cannot use', () => {
    expect(() => voiceRegistrationCredentialSchema.parse({ ...credential, transport: 'udp' }))
      .toThrow()
  })

  it('cannot express an unencrypted media path', () => {
    expect(() => voiceRegistrationCredentialSchema.parse({ ...credential, mediaEncryption: 'none' }))
      .toThrow()
  })

  it('rejects a credential with no expiry — a registration that never lapses is a bug', () => {
    const { expiresAt: _drop, ...noExpiry } = credential
    expect(() => voiceRegistrationCredentialSchema.parse(noExpiry)).toThrow()
  })

  it('defaults a call snapshot to unmuted on the default route', () => {
    const snap = voiceCallSnapshotSchema.parse({
      callId: 'call-1', hubId: credential.hubId, state: 'incoming',
    })
    expect(snap.muted).toBe(false)
    expect(snap.audioRoute).toBe('default')
  })

  it('requires every capability to be stated explicitly', () => {
    expect(() => voiceCapabilitiesSchema.parse({ inAppAudio: true })).toThrow()
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd /path/to/repo && bunx vitest run packages/protocol/__tests__/voice-schema.test.ts`
Expected: FAIL — `Cannot find module '../schemas/voice'`.

- [ ] **Step 3: Write the schema**

```ts
// packages/protocol/schemas/voice.ts
import { z } from 'zod/v4'
import { uuidSchema } from './common'

// --- Enums (excluded from codegen as standalone types; emitted where embedded) ---

export const voiceTransportSchema = z.enum(['tls', 'wss'])

// 'none' and 'zrtp' are deliberately absent: spec §9 rejects both, and a value the client
// must refuse at runtime does not belong in the type. 'srtp' is for legacy self-hosted trunks.
export const voiceMediaEncryptionSchema = z.enum(['dtls-srtp', 'srtp'])

export const voiceRegistrationStateSchema = z.enum([
  'none', 'progress', 'ok', 'cleared', 'failed',
])

export const voiceCallStateSchema = z.enum([
  'idle', 'incoming', 'outgoing', 'connecting', 'active', 'held', 'ending', 'ended', 'failed',
])

export const voiceUnavailableReasonSchema = z.enum([
  'no-provider', 'not-configured', 'call-preference-phone',
  'permission-denied', 'registrar-unreachable', 'credential-revoked',
])

export const audioRouteSchema = z.enum([
  'earpiece', 'speaker', 'bluetooth', 'headset', 'default',
])

// --- Credentials ---

export const voiceIceServerSchema = z.object({
  urls: z.array(z.string()).min(1),
  username: z.string().optional(),
  credential: z.string().optional(),
  credentialExpiresAt: z.string().optional(),
})

export const voiceRegistrationCredentialSchema = z.object({
  hubId: uuidSchema,
  realm: z.string().min(1),
  domain: z.string().min(1),
  transport: voiceTransportSchema,
  username: z.string().min(1),
  password: z.string().min(1),
  // When to re-mint over the API. NOT the SIP binding expiry, which the registrar sets and
  // the REGISTER exchange negotiates. Never wire this into AccountParams.expires.
  expiresAt: z.string().min(1),
  mediaEncryption: voiceMediaEncryptionSchema,  // 'none' and 'zrtp' are unrepresentable — spec §9
  iceServers: z.array(voiceIceServerSchema).optional().default([]),
})

// --- Capabilities ---

export const voiceCapabilitiesSchema = z.object({
  inAppAudio: z.boolean(),
  hold: z.boolean(),
  dtmf: z.boolean(),
  audioRouteSelection: z.boolean(),
  deviceSelection: z.boolean(),
  platformCallUi: z.boolean(),
})

// --- The endpoint response. One call, every member hub. ---

export const voiceRegistrationSetSchema = z.object({
  registrations: z.array(voiceRegistrationCredentialSchema),
  capabilities: voiceCapabilitiesSchema,
  unavailableReason: voiceUnavailableReasonSchema.optional(),
})

// --- Observable client state ---

export const voiceHubRegistrationSchema = z.object({
  hubId: uuidSchema,
  state: voiceRegistrationStateSchema,
  lastChangedAt: z.string(),
  failureReason: z.string().optional(),
})

export const voiceCallSnapshotSchema = z.object({
  callId: z.string().min(1),
  hubId: uuidSchema,
  state: voiceCallStateSchema,
  muted: z.boolean().optional().default(false),
  audioRoute: audioRouteSchema.optional().default('default'),
  startedAt: z.string().optional(),
})

// --- Push → voice handoff. One spelling, replacing Android's kebab and iOS's camel. ---

export const voiceCallHandoffSchema = z.object({
  callId: z.string().min(1),
  hubId: uuidSchema,
})

export type VoiceRegistrationCredential = z.infer<typeof voiceRegistrationCredentialSchema>
export type VoiceRegistrationSet = z.infer<typeof voiceRegistrationSetSchema>
export type VoiceCapabilities = z.infer<typeof voiceCapabilitiesSchema>
export type VoiceCallState = z.infer<typeof voiceCallStateSchema>
export type VoiceCallSnapshot = z.infer<typeof voiceCallSnapshotSchema>
export type VoiceCallHandoff = z.infer<typeof voiceCallHandoffSchema>
export type VoiceHubRegistration = z.infer<typeof voiceHubRegistrationSchema>
export type VoiceUnavailableReason = z.infer<typeof voiceUnavailableReasonSchema>
export type AudioRoute = z.infer<typeof audioRouteSchema>
```

- [ ] **Step 4: Export it from the barrel**

Add to `packages/protocol/schemas/index.ts`, in the same alphabetical position the other entries
use (it sits just before the `webrtc` line):

```ts
export * from './voice'
```

- [ ] **Step 5: Exclude the bare enums from standalone codegen**

In `packages/protocol/tools/schema-registry.ts`, add these six names to the `EXCLUDED_SCHEMAS` set,
alongside the existing bare-enum entries:

```ts
  'voiceTransportSchema',
  'voiceMediaEncryptionSchema',
  'voiceRegistrationStateSchema',
  'voiceCallStateSchema',
  'voiceUnavailableReasonSchema',
  'audioRouteSchema',
```

- [ ] **Step 6: Delete the two superseded schemas**

In `packages/protocol/schemas/webrtc.ts`, remove `webrtcTokenResponseSchema` and
`sipTokenResponseSchema` entirely. Keep `telephonyStatusResponseSchema` — Task 3 still uses it.
The file becomes:

```ts
import { z } from 'zod'

// --- Response schemas ---

export const telephonyStatusResponseSchema = z.object({
  available: z.boolean(),
  provider: z.string().nullable(),
})
```

- [ ] **Step 7: Run the test and codegen**

Run: `bunx vitest run packages/protocol/__tests__/voice-schema.test.ts && bun run codegen`
Expected: tests PASS; codegen completes. `apps/worker/routes/webrtc.ts` will now fail typecheck
because it imports the deleted schemas — that is Task 3's job and is expected at this point.

- [ ] **Step 8: Confirm the generated types exist on both mobile targets**

Run: `grep -l "VoiceRegistrationSet" packages/protocol/generated/swift/Types.swift packages/protocol/generated/kotlin/Types.kt`
Expected: both files listed. If either is missing, the barrel export in Step 4 did not take.

- [ ] **Step 9: Commit**

```bash
git add packages/protocol/schemas/voice.ts packages/protocol/schemas/index.ts \
        packages/protocol/schemas/webrtc.ts packages/protocol/tools/schema-registry.ts \
        packages/protocol/__tests__/voice-schema.test.ts
git commit -m "feat(protocol): one voice contract replacing four disagreeing shapes"
```

---

### Task 2: The `softphone.*` i18n namespace

Done before the client tasks, because all three consume these keys.

**Files:**
- Modify: `packages/i18n/locales/en.json` and every other locale in `packages/i18n/locales/`
- Test: `bun run i18n:validate:all`

**Interfaces:**
- Produces: the key set below, available to desktop as `t('softphone.…')`, to iOS as a localized
  string ref, and to Android as `R.string.softphone_…`.

**Do not add these under `voice.*`.** That namespace is caller-facing IVR prompt text fed to a
text-to-speech engine. A UI error string placed there will eventually be read aloud to a caller.

- [ ] **Step 1: Add the namespace to `en.json`**

```json
  "softphone": {
    "unavailable": "You cannot receive calls in the app right now",
    "reasonNoProvider": "No telephony provider is configured for this hub.",
    "reasonNotConfigured": "In-app audio is not available on this deployment.",
    "reasonCallPreferencePhone": "Your call preference is set to phone only.",
    "reasonPermissionDenied": "Microphone access is required to answer calls in the app.",
    "reasonRegistrarUnreachable": "Cannot reach the calling service. Retrying.",
    "reasonCredentialRevoked": "Your calling access was revoked. Sign in again.",
    "registering": "Connecting to the calling service…",
    "registered": "Ready to receive calls",
    "registrationFailed": "Could not connect to the calling service",
    "stateIncoming": "Incoming call",
    "stateConnecting": "Connecting…",
    "stateActive": "On a call",
    "stateHeld": "On hold",
    "stateEnding": "Ending…",
    "stateFailed": "Call failed",
    "answer": "Answer",
    "decline": "Decline",
    "hangUp": "Hang up",
    "mute": "Mute",
    "unmute": "Unmute"
  },
```

- [ ] **Step 2: Propagate to every other locale**

Every locale file in `packages/i18n/locales/` needs the same key set. Use the repo's own
i18n workflow rather than hand-editing 21 files; `packages/i18n/languages.ts` is the authoritative
list of locales — never hardcode a count.

- [ ] **Step 3: Generate and validate**

Run: `bun run i18n:codegen && bun run i18n:validate:all`
Expected: PASS, all locales complete. A missing key in any locale fails loudly here.

- [ ] **Step 4: Commit**

```bash
git add packages/i18n/locales
git commit -m "feat(i18n): softphone namespace, kept clear of the TTS voice namespace"
```

---

### Task 3: The server returns the contract, and declines to issue

The behavioural heart of this plan. After this task the endpoint tells the truth: there is no
in-app audio yet, and it says so in a shape the clients can act on.

**Files:**
- Modify: `apps/worker/routes/webrtc.ts`
- Test: `apps/worker/__tests__/unit/voice-registration.test.ts` (create)
- Delete: `apps/worker/__tests__/unit/sip-params.test.ts`

**Interfaces:**
- Consumes: `voiceRegistrationSetSchema` from Task 1.
- Produces: `GET /api/telephony/sip-token` → `VoiceRegistrationSet`;
  `GET /api/telephony/sip-status` → `{ available, provider }` unchanged.

**On the two existing unit suites.** `sip-params.test.ts` is a near-duplicate of
`sip-tokens.test.ts` over the same module; its own header says it exists because other targets were
skipped. Delete it. **Keep `sip-tokens.test.ts` unchanged** — it covers
`isSipConfigured`/`generateSipParams`, which this plan does not touch (Global Constraints), and
Phase 1 still needs that module. If you find yourself editing it, you have gone out of scope.

- [ ] **Step 1: Write the failing test**

```ts
// apps/worker/__tests__/unit/voice-registration.test.ts
import { describe, it, expect } from 'vitest'
import { voiceRegistrationSetSchema } from '@protocol/schemas'
import { buildVoiceRegistrationSet } from '../../routes/webrtc'

describe('buildVoiceRegistrationSet', () => {
  it('conforms to the published contract', () => {
    const result = buildVoiceRegistrationSet({ callPreference: 'browser', hasProvider: true })
    expect(() => voiceRegistrationSetSchema.parse(result)).not.toThrow()
  })

  it('issues nothing while no home realm is configured', () => {
    const result = buildVoiceRegistrationSet({ callPreference: 'browser', hasProvider: true })
    expect(result.registrations).toEqual([])
    expect(result.capabilities.inAppAudio).toBe(false)
    expect(result.unavailableReason).toBe('not-configured')
  })

  it('reports a phone-only preference as its own reason, not as misconfiguration', () => {
    const result = buildVoiceRegistrationSet({ callPreference: 'phone', hasProvider: true })
    expect(result.unavailableReason).toBe('call-preference-phone')
    expect(result.capabilities.inAppAudio).toBe(false)
  })

  it('reports a missing provider as its own reason', () => {
    const result = buildVoiceRegistrationSet({ callPreference: 'both', hasProvider: false })
    expect(result.unavailableReason).toBe('no-provider')
  })

  it('never returns a credential pointing at a telephony vendor', () => {
    for (const pref of ['browser', 'both'] as const) {
      const result = buildVoiceRegistrationSet({ callPreference: pref, hasProvider: true })
      expect(result.registrations).toHaveLength(0)
    }
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bunx vitest run apps/worker/__tests__/unit/voice-registration.test.ts`
Expected: FAIL — `buildVoiceRegistrationSet` is not exported.

- [ ] **Step 3: Implement the builder and rewrite the handler**

In `apps/worker/routes/webrtc.ts`, replace the `sipTokenResponseSchema` import with
`voiceRegistrationSetSchema`, add the exported builder, and rewrite the `/sip-token` handler.
Delete the `/webrtc-token` route and its `webrtcTokenResponseSchema` import — the Twilio browser
token it mints has no consumer once Task 4 lands, and leaving a dead credential endpoint on an
authenticated router is a liability rather than a convenience.

```ts
import type { VoiceRegistrationSet } from '@protocol/schemas'
import { voiceRegistrationSetSchema, telephonyStatusResponseSchema } from '@protocol/schemas'

const NO_CAPABILITIES = {
  inAppAudio: false, hold: false, dtmf: false,
  audioRouteSelection: false, deviceSelection: false, platformCallUi: false,
} as const

/**
 * Phase 0: the client contract exists and the server declines to fill it.
 *
 * Issuing a credential today would hand every volunteer the hub's shared trunk
 * credential pointed at the telephony vendor — see the spec, §1.1. Phase 1 adds a
 * home realm and this function starts returning one credential per member hub.
 */
export function buildVoiceRegistrationSet(input: {
  callPreference: 'phone' | 'browser' | 'both'
  hasProvider: boolean
}): VoiceRegistrationSet {
  if (input.callPreference === 'phone') {
    return { registrations: [], capabilities: NO_CAPABILITIES, unavailableReason: 'call-preference-phone' }
  }
  if (!input.hasProvider) {
    return { registrations: [], capabilities: NO_CAPABILITIES, unavailableReason: 'no-provider' }
  }
  return { registrations: [], capabilities: NO_CAPABILITIES, unavailableReason: 'not-configured' }
}

webrtc.get('/sip-token',
  describeRoute({
    tags: ['WebRTC'],
    summary: 'Voice registration credentials for every member hub',
    responses: {
      ...authErrors,
      200: {
        description: 'Registration set. May be empty with a reason; that is not an error.',
        content: { 'application/json': { schema: resolver(voiceRegistrationSetSchema) } },
      },
    },
  }),
  async (c) => {
    const volunteer = /* existing lookup, unchanged */
    const config = await services.settings.getTelephonyProvider()
    return c.json(buildVoiceRegistrationSet({
      callPreference: volunteer.callPreference ?? 'phone',
      hasProvider: config !== null,
    }))
  })
```

Note the status-code change, and make it deliberately: the handler no longer returns 400 or 404 for
a phone-only preference or a missing provider. Those are **states**, not errors — the client needs
to render a reason, and an error status invites the `try?` swallowing that hid this bug on iOS for
months. `/sip-status` keeps its existing shape and `telephonyStatusResponseSchema`.

- [ ] **Step 4: Run the tests**

Run: `bunx vitest run apps/worker/__tests__/unit/voice-registration.test.ts && bun run typecheck`
Expected: PASS, and typecheck now clean again (Task 1 left it failing here by design).

- [ ] **Step 5: Delete the duplicate suite**

```bash
git rm apps/worker/__tests__/unit/sip-params.test.ts
bunx vitest run apps/worker/__tests__/unit/sip-tokens.test.ts
```
Expected: `sip-tokens.test.ts` still PASSES untouched. If it fails you have modified
`sip-tokens.ts`, which this plan forbids.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/routes/webrtc.ts apps/worker/__tests__/unit/voice-registration.test.ts
git commit -m "feat(voice): sip-token returns the contract and declines to issue until a realm exists"
```

---

### Task 4: Desktop — capability-driven state, no provider gating

**Files:**
- Modify: `src/client/lib/webrtc.ts`
- Delete: `src/client/lib/in-app-audio.ts`
- Modify: `src/client/lib/call-state.ts`
- Modify: `src/client/components/webrtc-call.tsx`
- Modify: `src/client/components/setup/InAppAudioNotice.tsx`,
  `src/client/components/setup/VoiceSmsProviderForm.tsx`,
  `src/client/components/admin-settings/telephony-provider-section.tsx`,
  `src/client/routes/settings.tsx`
- Test: `tests/webrtc-init.spec.ts` (modify — it exists and is being touched by #1171; rebase first)

**Interfaces:**
- Consumes: `VoiceCallState`, `VoiceCapabilities`, `VoiceUnavailableReason`, `VoiceRegistrationSet`
  from Task 1; `softphone.*` keys from Task 2.
- Produces: `getVoiceState(): VoiceCallState`, `getCapabilities(): VoiceCapabilities | null`,
  `getUnavailableReason(): VoiceUnavailableReason | null`,
  `onVoiceStateChange(handler: (s: VoiceCallState) => void): () => void`, `initVoice(): Promise<void>`.

**What is deliberately not in this task.** No Rust, no IPC command, no liblinphone. Desktop cannot
carry audio until Plan 4, and pretending otherwise is the exact failure (#1147) this plan exists to
stop. This task makes the desktop UI *honest and contract-driven*, so Plan 4 changes one data
source and the UI already works.

**`in-app-audio.ts` is deleted rather than emptied, and rather than extended to eight providers.**
This is the clearest user-visible consequence of the whole architecture (spec §5, Layer 1): the
client gains **no** provider awareness, so there is no per-provider branch to get wrong and no
capability matrix to keep in sync when a ninth provider arrives. In-app audio stops being a
per-provider property. Its doc comment already anticipated this: *"Keep in sync … until in-app
audio for all providers is routed through the SIP bridge."*

A reviewer should reject this task if it replaces the two-member set with an eight-member one.

- [ ] **Step 1: Write the failing test**

```ts
// tests/webrtc-init.spec.ts — add to the existing file
import { test, expect } from '@playwright/test'

test('shows the reason when in-app audio is unavailable, and no Answer button', async ({ page }) => {
  await page.route('**/api/telephony/sip-token', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      registrations: [],
      capabilities: { inAppAudio: false, hold: false, dtmf: false,
                      audioRouteSelection: false, deviceSelection: false, platformCallUi: false },
      unavailableReason: 'not-configured',
    }),
  }))
  await page.goto('/')
  const status = page.getByTestId('webrtc-status')
  await expect(status).toHaveAttribute('data-state', 'idle')
  await expect(status).toHaveAttribute('data-unavailable-reason', 'not-configured')
  await expect(page.getByTestId('voice-answer')).toHaveCount(0)
})

test('a phone-only preference reads as a preference, not a fault', async ({ page }) => {
  await page.route('**/api/telephony/sip-token', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      registrations: [],
      capabilities: { inAppAudio: false, hold: false, dtmf: false,
                      audioRouteSelection: false, deviceSelection: false, platformCallUi: false },
      unavailableReason: 'call-preference-phone',
    }),
  }))
  await page.goto('/')
  await expect(page.getByTestId('webrtc-status'))
    .toHaveAttribute('data-unavailable-reason', 'call-preference-phone')
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun run test -- tests/webrtc-init.spec.ts`
Expected: FAIL — no `data-unavailable-reason` attribute exists.

- [ ] **Step 3: Rewrite `webrtc.ts` as a contract-driven store**

Replace the module's `WebRtcState` type, the Twilio import block, and the provider gating. The
dynamic `@twilio/voice-sdk` import and its `TwilioDevice`/`TwilioConnection` interfaces go entirely
— they describe a package that is not installed and, per spec §1.3, cannot work in a packaged build.

```ts
import type { VoiceCallState, VoiceCapabilities, VoiceUnavailableReason } from '@protocol/schemas'
import { getVoiceRegistrations } from './api'

let currentState: VoiceCallState = 'idle'
let capabilities: VoiceCapabilities | null = null
let unavailableReason: VoiceUnavailableReason | null = null
const stateHandlers = new Set<(s: VoiceCallState) => void>()

function setState(next: VoiceCallState): void {
  currentState = next
  for (const h of stateHandlers) h(next)
}

export function getVoiceState(): VoiceCallState { return currentState }
export function getCapabilities(): VoiceCapabilities | null { return capabilities }
export function getUnavailableReason(): VoiceUnavailableReason | null { return unavailableReason }

export function onVoiceStateChange(handler: (s: VoiceCallState) => void): () => void {
  stateHandlers.add(handler)
  return () => { stateHandlers.delete(handler) }
}

/**
 * Reads the server's registration set and records what this deployment can do.
 * Media is carried by the Rust shell (see Plan 4); until that lands, capabilities
 * always come back false and the UI renders the reason.
 */
export async function initVoice(): Promise<void> {
  const set = await getVoiceRegistrations()
  capabilities = set.capabilities
  unavailableReason = set.unavailableReason ?? null
  setState('idle')
}

export function destroyVoice(): void {
  capabilities = null
  unavailableReason = null
  setState('idle')
}
```

- [ ] **Step 4: Render the reason and drop the provider gating**

In `webrtc-call.tsx`, add `data-unavailable-reason={getUnavailableReason() ?? undefined}` to the
badge, label it from `t('softphone.reason…')` keyed on the reason, and render the Answer control
only when `getCapabilities()?.inAppAudio` is true **and** state is `'incoming'`. Give the Answer
button `data-testid="voice-answer"`.

In the four files importing `supportsInAppAudio`, remove the import and drive the same UI from the
capability the server reports. Then:

```bash
git rm src/client/lib/in-app-audio.ts
```

- [ ] **Step 5: Fold `call-state.ts` into the voice store**

`call-state.ts` holds a second, disjoint notion of call state (`CallRef { id, hubId }`) consumed
only by `use-keyboard-shortcuts.ts`. Move its `getRingingCalls`/`getCurrentCall` accessors onto the
voice store as `VoiceCallSnapshot[]`, update `use-keyboard-shortcuts.ts`, and delete the file. Two
call-state notions is how they drift.

- [ ] **Step 6: Run the tests**

Run: `bun run typecheck && bun run test -- tests/webrtc-init.spec.ts`
Expected: PASS. Confirm `grep -rn "supportsInAppAudio\|@twilio/voice-sdk" src/` returns nothing.

- [ ] **Step 7: Commit**

```bash
git add -A src/client tests/webrtc-init.spec.ts
git commit -m "refactor(desktop): capability-driven voice state, no provider allow-list"
```

---

### Task 5: iOS — adopt the contract and make registration possible

**The client never decides which hubs to register.** It registers exactly what the set contains, and an empty set means register nothing. Hub eligibility is the server's call (spec §6); a client that filters the set has reintroduced the bug this task removes.

**Rebase onto #1088 before starting.** It edits `AppState.swift`, where `LinphoneService` is
constructed.

**Files:**
- Modify: `apps/ios/Sources/Services/LinphoneService.swift`
- Modify: `apps/ios/Sources/Services/APIService.swift`
- Modify: `apps/ios/Sources/ViewModels/ShiftsViewModel.swift`
- Test: `apps/ios/Tests/LinphoneServiceTests.swift`

**Interfaces:**
- Consumes: generated `VoiceRegistrationSet` / `VoiceRegistrationCredential` from Task 1.
- Produces: `LinphoneServiceProtocol.register(_ set: VoiceRegistrationSet) throws`,
  `unregisterAll()`, `handleVoipPush(_ handoff: VoiceCallHandoff)`.

Four defects close here: the hand-written struct (which cannot decode the server's response because
`expiry` is required and absent), the missing `AuthInfo` (without which REGISTER 401s), the
single-hub registration, and the unbounded pending-call map.

- [ ] **Step 1: Write the failing test**

```swift
// apps/ios/Tests/LinphoneServiceTests.swift
import XCTest
@testable import Llamenos

final class LinphoneServiceTests: XCTestCase {
    func testRegistersEveryHubInTheSet() throws {
        let service = LinphoneService()
        let set = VoiceRegistrationSet(
            registrations: [credential(hub: hubA), credential(hub: hubB)],
            capabilities: allOff, unavailableReason: nil)
        try service.register(set)
        XCTAssertEqual(service.registeredHubIdsForTesting.sorted(), [hubA, hubB].sorted(),
                       "the client registers exactly what the set contains")
    }

    func testAnEmptySetClearsEveryRegistration() throws {
        let service = LinphoneService()
        try service.register(VoiceRegistrationSet(
            registrations: [credential(hub: hubA)], capabilities: allOff, unavailableReason: nil))
        try service.register(VoiceRegistrationSet(
            registrations: [], capabilities: allOff, unavailableReason: "not-configured"))
        XCTAssertTrue(service.registeredHubIdsForTesting.isEmpty,
                      "revocation arrives as an empty set; it must take effect")
    }

    func testPendingCallMapIsBounded() {
        let service = LinphoneService()
        for i in 0..<200 {
            service.handleVoipPush(VoiceCallHandoff(callId: "call-\(i)", hubId: hubA))
        }
        XCTAssertLessThanOrEqual(service.pendingCallCountForTesting, 100,
                                 "unanswered pushes must not grow without bound")
    }
}
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun run ios:test`
Expected: FAIL — `register(_:)` does not exist; `registeredHubIdsForTesting` does not exist.

- [ ] **Step 3: Delete the hand-written struct and fix the endpoint**

In `LinphoneService.swift`, delete the `struct SipTokenResponse` block entirely — the generated
`VoiceRegistrationCredential` replaces it.

In `APIService.swift`, correct the path and stop applying snake-case decoding to a camelCase
response:

```swift
func getVoiceRegistrations() async throws -> VoiceRegistrationSet {
    // The route is instance-level and returns every member hub's credential.
    // There is no hub-scoped variant, and there should not be: see the spec, §6.
    return try await request(method: "GET", path: "/api/telephony/sip-token")
}
```

Remove the old `getSipToken(hubId:)`. If the shared `request` helper applies
`keyDecodingStrategy = .convertFromSnakeCase` globally, override it for this call — the server
emits camelCase.

- [ ] **Step 4: Create `AuthInfo`, register every hub, stop swallowing**

```swift
func register(_ set: VoiceRegistrationSet) throws {
    #if canImport(linphonesw)
    guard let core else { throw LinphoneError.notInitialized }

    // Clear first: an empty set is how revocation reaches the client.
    for (_, account) in hubAccounts { core.removeAccount(account: account) }
    hubAccounts.removeAll()
    core.clearAllAuthInfo()

    for cred in set.registrations {
        // Without AuthInfo the REGISTER is unauthenticated and the registrar returns 401.
        // This is the single line whose absence meant registration has never worked.
        let auth = try Factory.Instance.createAuthInfo(
            username: cred.username, userid: nil, passwd: cred.password,
            ha1: nil, realm: cred.realm, domain: cred.domain)
        core.addAuthInfo(info: auth)

        let params = try core.createAccountParams()
        try params.setIdentityaddress(newValue: core.interpretUrl(url: "sip:\(cred.username)@\(cred.domain)"))
        try params.setServeraddress(newValue: core.interpretUrl(url: "sip:\(cred.domain);transport=\(cred.transport)"))
        params.registerEnabled = true
        let account = try core.createAccount(params: params)
        try core.addAccount(account: account)
        hubAccounts[cred.hubId] = account
    }
    #endif
}
```

Honour `cred.mediaEncryption` instead of the hardcoded `.SRTP`, and refuse `none` rather than
accepting it. Replace the unbounded pending map with a bounded one matching Android's 100-entry LRU.
Remove the `catch {}` at `ShiftsViewModel.swift:87` and the `try?` on the token fetch; surface both
as observable state the UI renders via `softphone.registrationFailed`.

- [ ] **Step 5: Register on clock-in, unregister on clock-out**

In `ShiftsViewModel.clockIn()`, replace the `hubContext.activeHubId` lookup with the whole set:

```swift
let set = try await apiService.getVoiceRegistrations()
try linphoneService.register(set)
```

- [ ] **Step 6: Run the tests**

Run: `bun run ios:test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/ios/Sources apps/ios/Tests
git commit -m "fix(ios): adopt the voice contract, create AuthInfo, register every member hub"
```

---

### Task 6: Android — adopt the contract and wire registration at all

**Rebase onto #1088 first** (it edits `AppModule.kt`) and note #1161 touches `build.gradle.kts`.

**Files:**
- Modify: `apps/android/app/src/main/java/org/llamenos/hotline/telephony/LinphoneService.kt`
- Modify: `apps/android/app/src/main/java/org/llamenos/hotline/ui/shifts/ShiftsViewModel.kt`
- Modify: `apps/android/app/src/main/java/org/llamenos/hotline/di/AppModule.kt` (inject `LinphoneService` into `ShiftsViewModel`)
- Modify: `apps/android/app/src/main/java/org/llamenos/hotline/api/ApiService.kt`
- Modify: `apps/android/app/src/main/java/org/llamenos/hotline/model/ProtocolTypeAliases.kt`
- Test: `apps/android/app/src/test/java/org/llamenos/hotline/telephony/LinphoneServiceTest.kt`

**Interfaces:**
- Consumes: generated `VoiceRegistrationSet` from Task 1 (via `ProtocolTypeAliases.kt`).
- Produces: `LinphoneService.register(set: VoiceRegistrationSet)`, `unregisterAll()`,
  `registrationStates: StateFlow<List<VoiceHubRegistration>>`.

Android is further behind than iOS: `registerHubAccount` is called from nowhere at all, and
`ShiftsViewModel` does not even inject `LinphoneService`. It also never fetches a SIP token.

- [ ] **Step 1: Write the failing test**

```kotlin
// apps/android/app/src/test/java/org/llamenos/hotline/telephony/LinphoneServiceTest.kt
class LinphoneServiceTest {
    @Test
    fun `registers every hub in the set`() {
        val service = LinphoneService(context, activeHubState, scope)
        service.register(VoiceRegistrationSet(
            registrations = listOf(credential(hubA), credential(hubB)),
            capabilities = allOff, unavailableReason = null))
        assertEquals(setOf(hubA, hubB), service.registeredHubIdsForTesting)
    }

    @Test
    fun `an empty set clears every registration`() {
        val service = LinphoneService(context, activeHubState, scope)
        service.register(VoiceRegistrationSet(listOf(credential(hubA)), allOff, null))
        service.register(VoiceRegistrationSet(emptyList(), allOff, "not-configured"))
        assertTrue(service.registeredHubIdsForTesting.isEmpty())
    }

    @Test
    fun `a registration failure is observable, not swallowed`() {
        val service = LinphoneService(context, activeHubState, scope)
        service.register(VoiceRegistrationSet(listOf(credential(hubA, password = "")), allOff, null))
        assertTrue(service.registrationStates.value.any { it.state == "failed" })
    }
}
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun run test:android`
Expected: FAIL — `register` and `registrationStates` do not exist.

- [ ] **Step 3: Delete the hand-written struct and add the generated alias**

Remove `data class SipTokenResponse(...)` from `LinphoneService.kt`. Add the generated type to
`ProtocolTypeAliases.kt` alongside the existing entries:

```kotlin
typealias VoiceRegistrationSet = org.llamenos.protocol.SharedVoiceRegistrationSet
typealias VoiceRegistrationCredential = org.llamenos.protocol.SharedVoiceRegistrationCredential
typealias VoiceHubRegistration = org.llamenos.protocol.SharedVoiceHubRegistration
```

- [ ] **Step 4: Implement `register`, with `AuthInfo` and without the silent catches**

```kotlin
private val _registrationStates = MutableStateFlow<List<VoiceHubRegistration>>(emptyList())
val registrationStates: StateFlow<List<VoiceHubRegistration>> = _registrationStates.asStateFlow()

fun register(set: VoiceRegistrationSet) {
    val core = core ?: run { publishFailure("core not initialised"); return }

    hubAccounts.values.forEach { core.removeAccount(it) }
    hubAccounts.clear()
    core.clearAllAuthInfo()

    val states = set.registrations.map { cred ->
        try {
            // Without AuthInfo the REGISTER is unauthenticated and the registrar returns 401.
            val auth = Factory.instance().createAuthInfo(
                cred.username, null, cred.password, null, cred.realm, cred.domain)
            core.addAuthInfo(auth)

            val params = core.createAccountParams().apply {
                identityAddress = core.interpretUrl("sip:${cred.username}@${cred.domain}")
                serverAddress = core.interpretUrl("sip:${cred.domain};transport=${cred.transport}")
                isRegisterEnabled = true
            }
            core.createAccount(params).also { core.addAccount(it); hubAccounts[cred.hubId] = it }
            VoiceHubRegistration(cred.hubId, "progress", now(), null)
        } catch (e: Exception) {
            // Deliberately not swallowed. A swallowed exception here is why nobody
            // noticed that registration has never worked on this platform.
            VoiceHubRegistration(cred.hubId, "failed", now(), e.message)
        }
    }
    _registrationStates.value = states
}
```

Apply the same treatment to `initialize()`: its `catch (_: Exception) {}` becomes an observable
failure. Honour `cred.mediaEncryption` rather than hardcoding `MediaEncryption.SRTP`.

- [ ] **Step 5: Wire clock-in — the step Android has never had**

`ShiftsViewModel` currently injects only `ApiService` and `ActiveHubState`. Add `LinphoneService`
and fetch the set:

```kotlin
suspend fun clockIn() {
    isClockingInOut = true
    try {
        apiService.request<ClockResponse>("POST", "/api/shifts/clock-in")
        val set = apiService.request<VoiceRegistrationSet>("GET", "/api/telephony/sip-token")
        linphoneService.register(set)
        loadShiftStatus()
    } finally { isClockingInOut = false }
}
```

`clockOut()` calls `linphoneService.unregisterAll()` after the POST.

- [ ] **Step 6: Run the tests**

Run: `bun run test:android`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/android
git commit -m "fix(android): adopt the voice contract and actually register on clock-in"
```

---

### Task 7: Multi-hub correctness on both mobile platforms

One behaviour, reviewed as one change: the active hub must switch on a tap or an answer, never on a
ring — and the push payload must have one spelling.

**Files:**
- Modify: `apps/ios/Sources/Services/LinphoneService.swift`, `apps/ios/Sources/App/LlamenosApp.swift`
- Modify: `apps/android/.../telephony/LinphoneService.kt`,
  `apps/android/.../service/PushNotificationRouter.kt`, `.../service/PushService.kt`
- Modify: `apps/android/.../ui/MainActivity.kt` (notification-tap handler — Android has none)
- Test: `apps/ios/Tests/MultiHubRoutingTests.swift`,
  `apps/android/app/src/test/java/org/llamenos/hotline/service/PushRoutingTest.kt`

**Interfaces:**
- Consumes: `VoiceCallHandoff` from Task 1.

Three defects: both platforms call `setActiveHub` from `IncomingReceived` — the *ring*, not the
answer — which `CLAUDE.md` and `PROTOCOL.md` §5.5 forbid; Android has no notification-tap handler at
all, so once the ring-event switch is removed it could never switch hub for a call; and the same two
logical fields are spelled `call-id`/`hub-id` on Android and `callId`/`hubId` on iOS.

- [ ] **Step 1: Write the failing tests**

```kotlin
// apps/android/app/src/test/java/org/llamenos/hotline/service/PushRoutingTest.kt
@Test fun `an incoming-call push never switches the active hub`() {
    router.routeWakePayload("incoming_call", hubB, "call-1")
    assertEquals(hubA, activeHubState.activeHubId, "a ring must not move the user's context")
}

@Test fun `a ring event never switches the active hub`() {
    service.onCallStateChangedForTesting(CallState.IncomingReceived, callId = "call-1")
    assertEquals(hubA, activeHubState.activeHubId)
}

@Test fun `answering switches to the call's hub`() {
    service.storePendingCallHub("call-1", hubB)
    service.answerForTesting("call-1")
    assertEquals(hubB, activeHubState.activeHubId)
}

@Test fun `tapping a call notification switches to its hub`() {
    mainActivity.handleNotificationTap(VoiceCallHandoff(callId = "call-1", hubId = hubB))
    assertEquals(hubB, activeHubState.activeHubId)
}
```

Write the iOS equivalents in `MultiHubRoutingTests.swift` against `LlamenosApp`'s
`handleNotificationResponse` and the answer path.

- [ ] **Step 2: Run them and confirm they fail**

Run: `bun run test:android && bun run ios:test`
Expected: the ring-event tests FAIL (the switch happens today); the Android tap test FAILS to
compile (`handleNotificationTap` does not exist).

- [ ] **Step 3: Move the switch off the ring event**

On both platforms, delete the `setActiveHub` call from the `IncomingReceived` branch. Keep the
pending-hub map write — attribution is still recorded at ring time; only the context switch moves.
Add the switch to the answer path instead, reading the hub from the pending map.

- [ ] **Step 4: Give Android a notification-tap handler**

iOS has one (`LlamenosApp.handleNotificationResponse`); Android has none. Add
`handleNotificationTap(handoff: VoiceCallHandoff)` to `MainActivity`, wired to the call
notification's content intent, calling `activeHubState.setActiveHub(handoff.hubId)`.

- [ ] **Step 5: One payload spelling**

In `PushService.kt`, replace the kebab reads with the contract's camelCase:

```kotlin
val handoff = VoiceCallHandoff(
    callId = data["callId"] ?: return,
    hubId  = data["hubId"] ?: return,
)
```

Update the server's push payload construction to emit `callId`/`hubId`, and update
`docs/protocol/PROTOCOL.md` §5.5 to state the one spelling.

- [ ] **Step 6: Run the tests**

Run: `bun run test:android && bun run ios:test`
Expected: PASS on both.

- [ ] **Step 7: Commit**

```bash
git add apps/ios apps/android apps/worker docs/protocol/PROTOCOL.md
git commit -m "fix(voice): switch hub on tap or answer, never on ring; one push payload spelling"
```

---

### Task 8: Behavioural coverage and the protocol document

The gap that let all of this ship: the e2e suite exercises the call UI, not the registration path.
`/api/telephony/sip-token` has no BDD coverage at all.

**Files:**
- Create: `packages/test-specs/features/core/voice-registration.feature`
- Create: `tests/steps/backend/voice-registration.steps.ts`
- Modify: `docs/protocol/PROTOCOL.md` (§4.18)

- [ ] **Step 1: Write the feature file**

```gherkin
# packages/test-specs/features/core/voice-registration.feature
@backend
Feature: Voice registration credentials
  As a volunteer
  I want the app to tell me truthfully whether it can carry call audio
  So that I never see an Answer button that yields silence

  Background:
    Given a hub with a configured telephony provider
    And I am a volunteer in that hub

  Scenario: The endpoint answers with the published contract
    When I request my voice registrations
    Then the response conforms to the voice registration set schema

  Scenario: No credential is issued while no home realm is configured
    When I request my voice registrations
    Then I receive no registrations
    And in-app audio is reported as unavailable
    And the reason is "not-configured"

  Scenario: A phone-only preference is a preference, not an error
    Given my call preference is "phone"
    When I request my voice registrations
    Then the request succeeds
    And the reason is "call-preference-phone"

  Scenario: A volunteer on shift in two hubs is told about both
    Given I am also a volunteer in a second hub
    And I am on shift in both hubs
    When I request my voice registrations
    Then the number of registrations equals the number of hubs I am on shift for

  Scenario: A hub I am a member of but not on shift for is excluded
    Given I am also a volunteer in a second hub
    And I am on shift only in the first hub
    When I request my voice registrations
    Then no registration is returned for the second hub

  Scenario: No credential ever points at a telephony vendor
    When I request my voice registrations
    Then no registration domain matches a configured provider's SIP domain
```

The fourth and fifth scenarios will pass trivially while the set is empty. **That is intentional and
must be said in the file's own comments:** they are the assertions Plan 2 turns on, written now so
that the realm cannot land without them. Delete neither.

- [ ] **Step 2: Run and confirm it fails**

Run: `bun run test:backend:bdd -- --name "Voice registration"`
Expected: FAIL — undefined steps.

- [ ] **Step 3: Implement the step definitions**

Create `tests/steps/backend/voice-registration.steps.ts` following the existing backend step
conventions in that directory: real authenticated API calls against the local backend, per-test
schema isolation, no backdoor endpoints. Validate the response with
`voiceRegistrationSetSchema.parse` rather than hand-asserting fields.

- [ ] **Step 4: Rewrite PROTOCOL.md §4.18**

Replace the current three-line `webrtc-token` block — which documents a shape nothing returns —
with the real endpoint, the `VoiceRegistrationSet` response, and a sentence recording that an empty
set with a reason is a success, not an error.

- [ ] **Step 5: Run everything**

Run: `bun run test:backend:bdd && bun run typecheck && bun run test:desktop`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/test-specs tests/steps docs/protocol/PROTOCOL.md
git commit -m "test(voice): behavioural coverage for the registration contract"
```

---

## Definition of done

- `grep -rn "supportsInAppAudio\|IN_APP_AUDIO_PROVIDERS\|@twilio/voice-sdk" src/ apps/` returns nothing —
  **deleted, not replaced by a longer provider list.** The client must contain no provider name
  in any voice code path.
- `apps/worker/telephony/*.ts` is untouched: the eight IVR adapters are out of scope.
- No hand-written `SipTokenResponse` remains on either mobile platform.
- `bun run typecheck`, `bun run test:desktop`, `bun run test:android`, `bun run ios:test`,
  `bun run test:backend:bdd`, `bun run i18n:validate:all` all pass.
- The desktop UI states a reason instead of offering an Answer button that does nothing.
- Both mobile clients register every member hub, with `AuthInfo`, or report why they could not.
- No `setActiveHub` call remains on any ring or background-push path.
- **No client registers against a telephony vendor.** Verified by the last BDD scenario.
