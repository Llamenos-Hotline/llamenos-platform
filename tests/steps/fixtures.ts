import { type APIRequestContext } from '@playwright/test'
import { test as base, createBdd } from 'playwright-bdd'
import { createHubViaApi, ensureAdminRole, type RoleDefinition } from '../api-helpers'
import type { SeededConversation } from '../conversation-seeding'
import { devSurfaceHeaders } from '../dev-surface-secret'

// ── Scenario-scoped World types ──────────────────────────────────────
// Each scenario gets a fresh instance via fixture. Step definitions read/write
// these instead of module-level `let` variables, enabling safe parallelism.

export type AdminWorld = {
  lastUserName: string
  lastUserPubkey: string
  lastShiftName: string
  lastPhone: string
  lastBanReason: string
  lastHubId: string
  lastHubName: string
  /** Display name set by 'I change my display name', checked after a reload. */
  lastDisplayName: string
  /** Hub's effective voiceCaptchaEnabled before a scenario toggled it; `After` restores it. */
  spamCaptchaBefore?: boolean
  /** The hub the CAPTCHA toggle scenario acted in — its override is what `After` restores (#1137). */
  spamCaptchaHubId?: string
  /** Volunteer name typed by 'I fill in the volunteer name' (setup wizard invite step). */
  setupVolunteerName?: string
  /** Blast name composed by 'I compose a blast message', checked in the blast list. */
  blastName?: string
  /** Whether a locked-crypto operation was rejected ('I attempt to create an auth token' etc.). */
  cryptoRejected?: boolean
  /** Name on the invite created by 'I create an invite for a new volunteer'. */
  inviteVolunteerName?: string
}

export type RolesWorld = {
  cachedRoles: RoleDefinition[]
  lastCreatedRoleId: string
  volunteerNsec: string
  reporterNsec: string
  /** HTTP status recorded by an 'I attempt to access …' step, asserted by the paired Then. */
  endpointStatus?: number
  /** HTTP status recorded by a role-deletion attempt, asserted by the paired Then. */
  deleteStatus?: number
  /** Role fetched by 'I request the {string} role details'. */
  inspectedRole?: RoleDefinition
  /** HTTP status recorded by a role-creation attempt (plaintext-name refusal scenario). */
  roleCreateStatus?: number
  /** Result of 'I request the permissions catalog'. */
  permissionsCatalog?: {
    permissions: Record<string, string>
    byDomain: Record<string, Array<{ key: string; label: string }>>
  }
}

/** Backup restore scenarios (packages/test-specs/.../auth/backup-restore.feature). */
export type BackupWorld = {
  /** Recovery key displayed to the user when the backup was written. */
  recoveryKey: string
  /** PIN the backup was written under. */
  pin: string
  /** Signing pubkey of the device key the backup was made from. */
  pubkeyHex: string
  /** Path of the backup file on disk, for the file input. */
  filePath: string
}

export type CasesWorld = {
  createdCaseTitle: string
  lastCreatedRecordId: string
  volunteerPubkey: string
  lastRecordId: string
  initialFieldCount: number
  // Events
  eventEntityTypeId: string
  lastEventId: string
  lastEventName: string
  // Contacts
  contactCarlosId: string
  contactMariaId: string
  contactWithDataId: string
  // Display name used to create contactWithDataId — lets steps locate it
  // deterministically via the directory search box instead of guessing at
  // the first rendered card in a shared, accumulating hub (issue #796).
  contactWithDataName: string
  // Triage
  triageReportTypeId: string
  triageReportId: string
  // Smart assignment: suggestions returned for lastRecordId
  lastSuggestions: Array<Record<string, unknown>>
}

export type ConversationWorld = {
  /**
   * The conversation the scenario's Given step seeded and selected. Steps that
   * must re-select it after the app clears the detail selection (closing sets
   * selectedId to null) find it by its contact label.
   */
  seeded?: SeededConversation
  /** The outbound message posted by "I sent a message in a conversation". */
  outbound?: { conversationId: string; messageId: string; body: string }
  /** Inbound messages simulated at the worker's hub from one sender, in arrival order. */
  inbound?: { label: string; conversationIds: string[]; bodies: string[] }
}

export type SasWorld = {
  ephemeralPubkey?: string    // X25519 pubkey hex (secret stays in Rust/mock state)
  primarySecret?: Uint8Array  // test-only: simulates the primary device's key
  primaryPubkey?: string
  sasCode?: string
  encryptedNsec?: string
  mockNsec?: string
}

/** Ban scenarios (ban-steps.ts, interaction-steps.ts, user-steps.ts). */
export type BanWorld = {
  /** Number the scenario's add/import step banned — bans are located by reason, not number. */
  phone?: string
  /** Reason the scenario banned under — unique within the scenario's own hub. */
  reason?: string
  /** The two numbers a bulk-add/import step banned. */
  phones?: string[]
}

/** Call scenarios (in-call-actions-steps.ts, custom-fields-steps.ts). */
export type CallsWorld = {
  /** Call established by 'I have an active call', ended by 'the call ends'. */
  activeCallId?: string
  /** Call a note was filed under ('I create a note with a specific call ID'). */
  noteCallId?: string
}

/** Multi-hub scenarios (hub-steps.ts, multi-hub-call-steps.ts). */
export type HubsWorld = {
  /** The second hub 'a volunteer assigned to multiple hubs' created. */
  secondHubId?: string
  /** Pubkey of the volunteer holding membership in both hubs. */
  multiHubVolunteerPubkey?: string
  /** The call that rang on the second hub. */
  multiHubCallId?: string
}

/** Shift scheduling scenarios (scheduling-steps.ts, shift-detail-steps.ts). */
export type ShiftsWorld = {
  /** Name of the shift the scenario created or renamed — unique per step that sets it. */
  shiftName?: string
  /** Selected-badge count before 'I tap a volunteer assignment card' toggled one. */
  badgeCountBefore?: number
}

/** Dashboard scenarios (dashboard-steps.ts; written by auth-steps.ts's on-shift login). */
export type DashboardWorld = {
  /** Clock button label before 'I tap the dashboard clock button' flipped it. */
  clockLabelBefore?: string
  /** Pubkey the 'I am logged in as a volunteer on shift' step logged in as. */
  volunteerPubkey?: string
}

/** Report scenarios (report-steps.ts, user-steps.ts). */
export type ReportsWorld = {
  /** Form-control count before a template report type was selected. */
  controlsBefore?: number
  /** Title 'they create a new report' saved under — unique per scenario. */
  reportTitle?: string
}

/** Bare endpoint probes (navigation-steps.ts, auth-guards-steps.ts). */
export type ApiWorld = {
  /** Status 'I check the API health endpoint' received. */
  healthStatus?: number
  /** Body 'I check the API config endpoint' received. */
  configBody?: string
  /** Status of an intentionally unauthenticated request. */
  responseStatus?: number
}

/** Shape returned by platform.deviceGenerateAndLoad / deviceImportAndLoad. */
export type EncryptedDeviceKeys = {
  kdfVersion: number
  salt: string
  nonce: string
  ciphertext: string
  argon2MCost: number
  argon2TCost: number
  argon2PCost: number
  state: { deviceId: string; signingPubkeyHex: string; encryptionPubkeyHex: string }
}

/** Parsed body of a platform.createAuthToken token. */
export type ParsedAuthToken = { pubkey: string; timestamp: number; token: string; nonce?: string }

/** What platform.encryptNote returns, as the crypto steps consume it. */
export type EncryptedNotePayload = {
  encryptedContent: string
  authorEnvelope: { enc: string; ct: string }
  adminEnvelopes: Array<{ pubkey: string; enc: string; ct: string }>
}

/**
 * Crypto-interop scenarios (crypto-steps.ts). Every value here is produced by a
 * `window.__TEST_PLATFORM` call inside the page and handed back to the runner —
 * no key material, only pubkeys, envelopes and booleans.
 */
export type CryptoWorld = {
  /** Device public state from the last generate/import/unlock. */
  device?: EncryptedDeviceKeys['state']
  deviceA?: EncryptedDeviceKeys['state']
  deviceB?: EncryptedDeviceKeys['state']
  /** State of the same seed imported a second time under a different PIN. */
  deviceReimported?: EncryptedDeviceKeys['state']
  /** Public keys the admin bootstrap script issued; the seed is kept only to re-import. */
  issued?: { seedHex: string; identityPubkey: string; decryptionPubkey: string }
  /** Two provisioning-session pubkeys plus the device's own encryption pubkey. */
  linkSession?: { first: string; second: string; deviceEncryptionPubkey: string }
  /** The note the scenario last encrypted. */
  note?: EncryptedNotePayload
  /** Decrypt result of `note` — null when the envelope did not open. */
  notePlaintext?: string | null
  /** Admin encryption pubkeys a note was sealed to. */
  admins?: string[]
  /** Two encryptions of one payload, with their unwrapped-content-key comparison. */
  notesPair?: {
    one: { encryptedContent: string }
    two: { encryptedContent: string }
    keysEqual: boolean
    keyLen: number
  }
  /** `note.encryptedContent` with one nibble flipped — must fail the GCM tag check. */
  tampered?: string
  /** A message sealed to this device and one other reader. */
  msg?: {
    msg: { encryptedContent: string; readerEnvelopes: Array<{ pubkey: string; enc: string; ct: string }> }
    mine: string
    other: string
  }
  /** A key wrapped under a named label, with the original key hex for in-page comparison. */
  wrapped?: { env: unknown; keyHex: string }
  /** Shape summary of a recoveryGroupCreate result (share envelope included for refusal checks). */
  recoveryGroup?: { keys: string[]; envelopes: number; commitments: number; envelope: unknown }
  /** Claims the simulated primary signed (and the ones that must be refused), plus the code it derived. */
  sasClaims?: {
    claim: string
    expected: string
    otherPrimaryClaim: string
    otherRoomClaim: string
    barePubkey: string
  }
  /** SAS codes: same input twice, then a different input. */
  sas?: { first: string; again: string; different: string }
  /** First auth token, with its request binding and the time the step started. */
  token?: ParsedAuthToken & { method: string; path: string; createdAfter?: number }
  /** Second auth token, for signature/coverage comparisons. */
  token2?: ParsedAuthToken & { method: string; path: string }
  /** Outcome of a token creation attempted while locked. */
  lockedToken?: { rejected: boolean }
  /** The full record 'I encrypt the key with PIN' persisted. */
  encrypted?: EncryptedDeviceKeys
  /** Outcome of the last unlock attempt. */
  unlock?: { ok: boolean; error: string | null }
}

/**
 * Extended test fixture that monitors API responses and page errors.
 * Catches buried 401/403/500 errors and unhandled JS exceptions that
 * would otherwise go unnoticed during test execution.
 *
 * workerHub: worker-scoped hub ID injected into the page via
 * window.__TEST_SET_ACTIVE_HUB — each Playwright worker gets its own
 * isolated hub so parallel tests don't share database state.
 */
export const test = base.extend<
  {
    apiErrors: { responses: Array<{ url: string; status: number }>; pageErrors: Error[] }
    backendRequest: APIRequestContext
    adminWorld: AdminWorld
    rolesWorld: RolesWorld
    casesWorld: CasesWorld
    backupWorld: BackupWorld
    conversationWorld: ConversationWorld
    sasWorld: SasWorld
    banWorld: BanWorld
    callsWorld: CallsWorld
    hubsWorld: HubsWorld
    shiftsWorld: ShiftsWorld
    dashboardWorld: DashboardWorld
    reportsWorld: ReportsWorld
    apiWorld: ApiWorld
    cryptoWorld: CryptoWorld
  },
  {
    workerHub: string
  }
>({
  // Backend API request context — targets the backend server directly (not the Vite preview).
  // Used by CMS step definitions that need to call API helpers for Given-step data setup.
  backendRequest: async ({ playwright }, use) => {
    const backendUrl = process.env.TEST_HUB_URL || 'http://localhost:3000'
    // extraHTTPHeaders from the Playwright PROJECT is not inherited by a
    // context made here, so the harness header has to be given explicitly —
    // see ../dev-surface-secret.ts.
    const ctx = await playwright.request.newContext({ baseURL: backendUrl, extraHTTPHeaders: devSurfaceHeaders() })
    await use(ctx)
    await ctx.dispose()
  },
  apiErrors: [async ({ page }, use) => {
    const state = { responses: [] as Array<{ url: string; status: number }>, pageErrors: [] as Error[] }

    // Monitor all API responses for server errors and auth failures
    page.on('response', async (response) => {
      const url = response.url()
      const status = response.status()
      // Only track /api/ calls, skip static assets and test-reset
      if (!url.includes('/api/') || url.includes('/api/test-reset')) return
      if (status >= 400) {
        state.responses.push({ url: url.replace(/^https?:\/\/[^/]+/, ''), status })
        // Log response body for 403s to help diagnose permission issues
        if (status === 403) {
          try {
            const body = await response.text()
            if (body.includes('debug')) {
              console.warn(`[test-monitor] 403 body: ${body.substring(0, 300)}`)
            }
          } catch { /* response may already be consumed */ }
        }
      }
    })

    // Monitor unhandled JS errors (React crashes, unhandled promise rejections)
    page.on('pageerror', (error) => {
      state.pageErrors.push(error)
    })

    await use(state)

    // After each test: hard-fail on 500s which indicate real server bugs.
    // Filter out known non-test-related 500s (SIP bridge health, WebSocket upgrades,
    // hub users list during setup, call simulation endpoints).
    const ignoredPaths = ['/api/health', '/api/sip-bridge', '/ws', '/api/hubs/', '/api/test-', '/api/calls/simulate']
    const serverErrors = state.responses.filter(r =>
      r.status >= 500 && !ignoredPaths.some(p => r.url.includes(p))
    )
    if (serverErrors.length > 0) {
      const summary = serverErrors.map(r => `${r.status} ${r.url}`).join('\n  ')
      throw new Error(`Server errors detected during test:\n  ${summary}`)
    }

    // Log 401/403 as warnings — these may be intentional (permission tests)
    // but are worth surfacing in trace output
    const authErrors = state.responses.filter(r => r.status === 401 || r.status === 403)
    if (authErrors.length > 0) {
      const summary = authErrors.map(r => `${r.status} ${r.url}`).join(', ')
      console.warn(`[test-monitor] Auth errors during test: ${summary}`)
    }

    // Hard-fail on unhandled page errors (React crashes, etc.)
    if (state.pageErrors.length > 0) {
      const summary = state.pageErrors.map(e => e.message).join('\n  ')
      throw new Error(`Unhandled page errors during test:\n  ${summary}`)
    }
  }, { auto: true }],
  // Scenario-scoped world objects — fresh per test, no cross-scenario leakage.
  adminWorld: async ({}, use) => {
    await use({ lastUserName: '', lastUserPubkey: '', lastShiftName: '', lastPhone: '', lastBanReason: '', lastHubId: '', lastHubName: '', lastDisplayName: '' })
  },
  rolesWorld: async ({}, use) => {
    await use({ cachedRoles: [], lastCreatedRoleId: '', volunteerNsec: '', reporterNsec: '' })
  },
  casesWorld: async ({}, use) => {
    await use({
      createdCaseTitle: '', lastCreatedRecordId: '', volunteerPubkey: '', lastRecordId: '',
      initialFieldCount: 0,
      eventEntityTypeId: '', lastEventId: '', lastEventName: '',
      contactCarlosId: '', contactMariaId: '', contactWithDataId: '', contactWithDataName: '',
      triageReportTypeId: '', triageReportId: '',
      lastSuggestions: [],
    })
  },
  backupWorld: async ({}, use) => {
    await use({ recoveryKey: '', pin: '', pubkeyHex: '', filePath: '' })
  },
  conversationWorld: async ({}, use) => {
    await use({})
  },
  sasWorld: async ({}, use) => {
    await use({})
  },
  banWorld: async ({}, use) => {
    await use({})
  },
  callsWorld: async ({}, use) => {
    await use({})
  },
  hubsWorld: async ({}, use) => {
    await use({})
  },
  shiftsWorld: async ({}, use) => {
    await use({})
  },
  dashboardWorld: async ({}, use) => {
    await use({})
  },
  reportsWorld: async ({}, use) => {
    await use({})
  },
  apiWorld: async ({}, use) => {
    await use({})
  },
  cryptoWorld: async ({}, use) => {
    await use({})
  },
  // Worker-scoped hub: created once per Playwright worker process.
  // Each worker gets its own isolated hub so parallel tests don't share state.
  // Hub is NOT deleted after tests — stale hubs accumulate and are purged separately.
  workerHub: [async ({ playwright }, use, workerInfo) => {
    const backendUrl = process.env.TEST_HUB_URL || 'http://localhost:3000'
    const ctx = await playwright.request.newContext({ baseURL: backendUrl, timeout: 60_000, extraHTTPHeaders: devSurfaceHeaders() })
    // Ensure admin has role-super-admin before creating hub — parallel workers
    // can race with test-reset, leaving the admin with role-volunteer which
    // causes cascading 403 failures on all hub-scoped and permission-guarded routes.
    await ensureAdminRole(ctx)
    const name = `test-hub-${workerInfo.workerIndex}-${Date.now()}`
    const hubId = await createHubViaApi(ctx, name)
    // Verify admin has hub membership — without this, all hub-scoped API calls
    // return 403 and the frontend fails to render hub pages (shard 1 CI failures).
    const { verifyHubMembership } = await import('../api-helpers')
    await verifyHubMembership(ctx, hubId)
    await ctx.dispose()
    await use(hubId)
  }, { scope: 'worker', timeout: 60_000 }],
})

export const { Given, When, Then, Before, After } = createBdd(test)
