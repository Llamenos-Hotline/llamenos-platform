# Epic 58: Demo Mode

> **RETIRED — #1604 (2026-10-07).** The operator decided the product is a secure
> hosted version plus self-hosting, with no demo mode. Everything this epic
> shipped that was demo-the-*product* is deleted: `DEMO_MODE`,
> `DEMO_MODE_CONFIRM`, `DEMO_RESET_CRON`, `POST /api/demo/reset`, the
> unauthenticated `GET /api/config/demo/credentials` login picker, the demo
> banner on desktop and Android, and the setup wizard's demo toggle. What was
> demo-the-*test-affordance* survives under honest names: the fixed fictional
> dataset is `apps/worker/lib/sample-dataset.ts`, seeded by
> `POST /api/test-seed-sample`, and the carrier-free call simulation is
> `apps/worker/routes/simulated-telephony.ts`. Kept below as the historical
> record of what was built.

## Overview

The production deployment at `demo.llamenos-platform.com` needs a demo mode that lets potential users explore the app without going through the full setup flow. Demo mode pre-populates the system with realistic test data across all roles (admin, volunteer, reporter) and shows login credentials on the login page so visitors can immediately try the app. The demo instance has real Twilio integration, so calls/SMS actually work.

Demo mode is controlled by an environment variable (`DEMO_MODE=true`), disabled by default, and has zero impact on non-demo deployments.

## Goals

1. Let visitors try the app immediately — no setup, no onboarding friction
2. Show the full breadth of features across all three roles
3. Use realistic (but obviously fake) data that tells a coherent story
4. Keep the real Twilio integration working so calls/SMS can be demonstrated
5. Prevent demo from being abused (periodic data reset, read-only seed data)

## Step 1: Environment Variable & Config Plumbing

### Problem

There's no way to flag a deployment as a demo instance. The `ENVIRONMENT` var distinguishes `development` vs `production` but that's for dev tooling, not for a public-facing demo.

### Solution

Add a new `DEMO_MODE` env var (string `"true"` or absent). Expose it to the client via the `/api/config` endpoint.

#### Implementation

**`src/worker/types.ts`** — Add to `Env` interface:
```typescript
DEMO_MODE?: string
```

**`src/worker/routes/config.ts`** — Include in response:
```typescript
return c.json({
  hotlineName: c.env.HOTLINE_NAME || 'Hotline',
  hotlineNumber,
  channels,
  setupCompleted,
  adminPubkey: c.env.ADMIN_PUBKEY,
  demoMode: c.env.DEMO_MODE === 'true',
})
```

**`src/client/lib/config.tsx`** — Add `demoMode: boolean` to context, default `false`.

**`wrangler.jsonc`** — Do NOT set `DEMO_MODE` in the default vars (it's off by default). Set it as a secret/var only on the demo deployment.

### Acceptance Criteria

- [ ] `DEMO_MODE` env var recognized by worker
- [ ] `/api/config` returns `demoMode: true/false`
- [ ] `useConfig()` exposes `demoMode` to client components
- [ ] Non-demo deployments are completely unaffected

---

## Step 2: Demo Seed Data & Auto-Population

### Problem

A fresh deployment has no data — an empty volunteer list, no call history, no notes, no shifts, no conversations. A visitor logging in sees a barren app with nothing to explore.

### Solution

When `DEMO_MODE=true`, the worker seeds Durable Objects with realistic demo data on first boot (or on reset). This runs once during DO initialization, not on every request.

#### Demo Accounts

All demo accounts use **deterministic keypairs** derived from known nsec values so they can be displayed on the login page.

| Role | Name | nsec | Purpose |
|------|------|------|---------|
| Admin | Demo Admin | `nsec1demo_admin_...` (pre-generated) | Full admin access, settings, volunteer management |
| Volunteer 1 | Maria Santos | `nsec1demo_vol1_...` | Active volunteer, has notes and call history |
| Volunteer 2 | James Chen | `nsec1demo_vol2_...` | Active volunteer, on current shift |
| Volunteer 3 | Fatima Al-Rashid | `nsec1demo_vol3_...` | Inactive volunteer (shows deactivated state) |
| Reporter | Community Reporter | `nsec1demo_reporter_...` | Reporter role, has submitted reports |

#### Demo Content to Seed

**IdentityDO:**
- 5 demo accounts (3 volunteers + admin + reporter) with profile data
- 1 expired invite code (shows invite history)
- WebAuthn disabled (demo uses nsec login only)

**SettingsDO:**
- `setupCompleted: true` (wizard skipped)
- Hotline name: "Llámenos Demo Hotline"
- All channels enabled (voice, SMS, reports)
- CAPTCHA enabled with sample config
- Custom fields: 3 example fields (Severity, Category, Follow-up Needed)
- IVR languages: English, Spanish, Chinese
- Transcription: enabled (shows the feature even if Whisper isn't processing)
- Telephony provider: Twilio (from env vars — real working config)
- Report categories: ["Safety Concern", "Noise Complaint", "Infrastructure", "Other"]
- Shift schedule: recurring weekly shifts with volunteer assignments

**RecordsDO:**
- 15-20 call records spanning the past 2 weeks (mix of answered, missed, voicemail)
- 8-10 encrypted notes attached to calls (demo notes encrypted with demo keys — readable by demo accounts)
- Audit log entries for the seeded actions
- Ban list with 2-3 entries (shows spam mitigation)

**ShiftManagerDO:**
- Current active shift with volunteers 1 & 2
- Past shifts showing history
- Upcoming shift schedule

**ConversationDO:**
- 3-4 conversations (mix of SMS and web reports)
- Messages showing back-and-forth with responses
- One closed conversation, others open

#### Implementation

**New file: `src/worker/lib/demo-seed.ts`**

A `seedDemoData(env: Env)` function that:
1. Checks if demo data already exists (idempotent — skip if `demo-seeded` flag is set in SettingsDO)
2. Generates all demo keypairs from hardcoded nsec values
3. POSTs data to each DO's internal routes
4. Sets a `demo-seeded` flag

**Trigger point:** Call `seedDemoData()` from the worker's `fetch` handler on the first request when `DEMO_MODE=true`, before routing. Use a module-level flag to avoid re-checking on every request.

**New file: `src/shared/demo-accounts.ts`**

Shared constants for demo account metadata (pubkeys, names, roles). Used by both the seed function and the login page UI. Does NOT contain nsec values — those go in a separate client-only file.

**New file: `src/client/lib/demo-accounts.ts`**

Client-side demo account list with nsec values for the login page display. Only imported when `demoMode` is true.

### Notes on Demo Encryption

Demo notes need to be readable by demo accounts. The seed function will:
1. Use the demo volunteer's pubkey + admin pubkey for ECIES envelopes
2. Encrypt with the standard E2EE flow (same as real notes)
3. Demo users can decrypt with their known nsec — proving the E2EE system works

### Acceptance Criteria

- [ ] Demo data seeds automatically on first boot with `DEMO_MODE=true`
- [ ] Seeding is idempotent (safe to restart worker)
- [ ] All 5 demo accounts exist with correct roles
- [ ] Call history shows realistic mix of call states
- [ ] Notes are properly E2EE-encrypted and readable by demo accounts
- [ ] Shifts, conversations, and reports are populated
- [ ] Settings are fully configured (no setup wizard needed)
- [ ] Custom fields, ban list, and spam settings are pre-configured

---

## Step 3: Demo Login Page

### Problem

Visitors arrive at the login page and see a PIN entry screen (for returning users) or a recovery key input. They have no idea what credentials to use or that this is a demo.

### Solution

When `demoMode` is true, the login page shows a "Demo Accounts" panel below the normal login UI. This panel lists each demo role with a one-click login button.

#### UI Design

```
┌─────────────────────────────────────────────────────┐
│                    🔒 Hotline                        │
│                                                     │
│  [Normal login UI — PIN / recovery key / passkey]   │
│                                                     │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ✨ Demo Mode — Try the app with a sample account   │
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │ 👤 Demo Admin                    [Log in →] │    │
│  │    Full access: manage volunteers, settings │    │
│  ├─────────────────────────────────────────────┤    │
│  │ 👤 Maria Santos (Volunteer)      [Log in →] │    │
│  │    Answer calls, write encrypted notes      │    │
│  ├─────────────────────────────────────────────┤    │
│  │ 👤 James Chen (Volunteer)        [Log in →] │    │
│  │    Currently on shift, active calls         │    │
│  ├─────────────────────────────────────────────┤    │
│  │ 👤 Community Reporter            [Log in →] │    │
│  │    Submit reports, track status             │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
│  ⓘ This is a demo instance. Data resets daily.     │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**One-click login flow:**
1. User clicks "Log in" next to a demo account
2. Client-side: derives keypair from the known nsec
3. Calls the standard `signIn()` flow with the demo nsec
4. Stores encrypted key in localStorage with a default PIN (`000000`)
5. Redirects to dashboard

#### Implementation

**`src/client/routes/login.tsx`** — Add `DemoAccountPicker` component, conditionally rendered when `useConfig().demoMode` is true. Placed below the existing login form.

**New component: `src/client/components/demo-account-picker.tsx`**
- Renders the demo account list with role descriptions
- Each row has a "Log in" button that triggers `signIn()` with the demo nsec
- Shows a subtle info banner about demo mode + daily reset
- Styled to be visually distinct from the real login UI (light border, different background)

### Acceptance Criteria

- [ ] Demo account picker only shows when `demoMode` is true
- [ ] Each demo account has a one-click login button
- [ ] Login flow works end-to-end (click → authenticated → dashboard)
- [ ] Role descriptions help visitors understand what each role can do
- [ ] Non-demo deployments show no trace of demo UI
- [ ] Demo accounts use a default PIN (`000000`) for simplicity

---

## Step 4: Setup Wizard Skip

### Problem

When `DEMO_MODE=true` and the admin account is pre-configured, the setup wizard should never appear. Currently the wizard is triggered when `setupCompleted` is false.

### Solution

The demo seed (Step 2) already sets `setupCompleted: true` in SettingsDO, so the wizard naturally won't trigger. However, we should also:

1. Ensure the `/api/config` response has `setupCompleted: true` in demo mode
2. Add a server-side guard: if `DEMO_MODE=true`, the setup endpoints should return the pre-configured state rather than allowing modification (prevents a demo visitor from breaking the setup for others)

#### Implementation

**`src/worker/routes/config.ts`** — Force `setupCompleted: true` when demo mode:
```typescript
setupCompleted: c.env.DEMO_MODE === 'true' ? true : setupState.setupCompleted,
```

**`src/worker/durable-objects/settings-do.ts`** — No changes needed if seed data is correct. The `PATCH /settings/setup` endpoint continues to work normally (demo users can explore the wizard UI if they want, but it won't block them).

### Acceptance Criteria

- [ ] Setup wizard never appears in demo mode
- [ ] Config endpoint always returns `setupCompleted: true` in demo mode
- [ ] Admin can still view settings pages and explore configuration

---

## Step 5: Demo Data Reset & Protection

### Problem

Demo visitors might delete volunteers, change settings, or create garbage data. The demo needs to stay usable for the next visitor.

### Solution

Implement a periodic auto-reset and protect critical demo data.

#### Auto-Reset

**Server-side scheduled reset** — Add a CRON trigger (Cloudflare Workers scheduled handler) that runs daily:
1. Wipes all DO storage via the existing `/reset` endpoints
2. Re-seeds demo data via `seedDemoData()`
3. Logs the reset in the audit trail

**`wrangler.jsonc`** — Add cron trigger (only on demo deployment):
```json
"triggers": {
  "crons": ["0 0 * * *"]  // midnight UTC daily
}
```

**`src/worker/index.ts`** — Add `scheduled` handler:
```typescript
async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
  if (env.DEMO_MODE === 'true') {
    await resetAndReseedDemo(env)
  }
}
```

#### Demo Banner

Show a persistent but dismissible banner at the top of the app when in demo mode:

```
┌────────────────────────────────────────────────────────────┐
│ ✨ You're exploring the Llámenos demo. Data resets daily.  │
│    Ready to deploy your own? → Get Started                [✕]│
└────────────────────────────────────────────────────────────┘
```

- Links to the marketing site's getting-started docs
- Dismissible per session (stored in sessionStorage)
- Styled as a subtle top banner (not blocking)

#### Implementation

**`src/worker/index.ts`** — Add `scheduled` export for cron trigger
**New file: `src/worker/lib/demo-reset.ts`** — `resetAndReseedDemo(env)` function
**New component: `src/client/components/demo-banner.tsx`** — Persistent banner, conditionally rendered in `__root.tsx`

### Acceptance Criteria

- [ ] Demo data resets automatically daily via cron
- [ ] Reset is clean — no stale data from previous visitors
- [ ] Demo banner shows in-app with link to marketing site
- [ ] Banner is dismissible per session
- [ ] Banner only appears in demo mode

---

## Step 6: Additional Demo Polish

### 6a: Demo-Aware Dashboard

The dashboard should feel alive in demo mode. The seed data ensures:
- **Active call count** shows 0 (no live calls, but history is populated)
- **On-shift volunteers** shows 2 (Maria & James)
- **Recent activity** shows recent call/note events from seed data
- **Getting Started checklist** is 100% complete (all steps done)

### 6b: Demo Call Flow (Twilio Integration)

Since the demo has real Twilio credentials:
- Visitors can actually call the demo hotline number
- The IVR plays, CAPTCHA works, and if a volunteer is "on shift" in the demo, their browser rings via WebRTC
- This is the most powerful demo feature — showing the actual product working

No special code needed — the existing telephony integration handles this. The seed data just needs to ensure shifts and volunteer WebRTC preferences are configured.

### 6c: Guided Tour (Future Enhancement)

Not in this epic, but noted for future: a step-by-step guided tour overlay (like Shepherd.js or similar) that walks visitors through key features. This would be a separate epic.

### 6d: Demo Login Page — Marketing Context

Add a brief "What is Llámenos?" blurb on the login page in demo mode, above the account picker:

```
Llámenos is a secure crisis hotline platform with end-to-end
encrypted notes, multi-language IVR, and real-time call routing.
Try it below with a demo account.
```

This helps visitors who arrive directly at the demo URL (not via the marketing site) understand what they're looking at.

### Acceptance Criteria

- [ ] Dashboard shows populated data (shifts, recent activity)
- [ ] Getting Started checklist shows as complete
- [ ] Real calls work through the demo Twilio number
- [ ] Demo volunteers have WebRTC call preference set (for browser-based answering)
- [ ] Login page includes brief product description in demo mode

---

## Files Summary

### New Files
| File | Purpose |
|------|---------|
| `src/worker/lib/demo-seed.ts` | Seeds all DOs with demo data |
| `src/worker/lib/demo-reset.ts` | Resets and re-seeds demo data (cron) |
| `src/shared/demo-accounts.ts` | Demo account metadata (pubkeys, names, roles) |
| `src/client/lib/demo-accounts.ts` | Demo nsec values for login page |
| `src/client/components/demo-account-picker.tsx` | One-click demo login UI |
| `src/client/components/demo-banner.tsx` | Persistent demo mode banner |

### Modified Files
| File | Change |
|------|--------|
| `src/worker/types.ts` | Add `DEMO_MODE` to Env |
| `src/worker/routes/config.ts` | Expose `demoMode` in config response |
| `src/worker/index.ts` | Add `scheduled` handler for cron reset, trigger seed on first request |
| `src/client/lib/config.tsx` | Add `demoMode` to config context |
| `src/client/routes/login.tsx` | Render `DemoAccountPicker` in demo mode |
| `src/client/routes/__root.tsx` | Render `DemoBanner` in demo mode |
| `wrangler.jsonc` | Add cron trigger (conditional on demo deployment) |

### Config Changes
| Config | Change |
|--------|--------|
| Demo deployment env vars | `DEMO_MODE=true` |
| `wrangler.jsonc` | Cron trigger for daily reset |

---

## Testing

### E2E Tests

**New file: `tests/demo-mode.spec.ts`**

Tests run against a worker with `DEMO_MODE=true`:

1. **Config endpoint** — Verify `/api/config` returns `demoMode: true`
2. **Demo login** — Click each demo account, verify redirect to dashboard
3. **Pre-populated data** — Login as admin, verify volunteers exist, call history populated, settings configured
4. **Setup wizard skipped** — Verify no setup redirect after admin login
5. **Demo banner** — Verify banner shows, can be dismissed, doesn't reappear in same session
6. **Role-specific views** — Login as volunteer, verify notes/calls visible; login as reporter, verify report submission works
7. **Non-demo mode** — Verify none of the demo UI appears when `DEMO_MODE` is not set (existing tests cover this implicitly)

### Manual Testing

- [ ] Call the demo Twilio number, verify IVR plays
- [ ] Login as volunteer, answer call via WebRTC
- [ ] Login as admin, review call history and notes
- [ ] Login as reporter, submit a report
- [ ] Verify daily reset works (trigger manually via wrangler cron)

---

## Acceptance Criteria (Epic-Level)

- [ ] `DEMO_MODE` env var controls all demo behavior — off by default
- [ ] Demo data seeds automatically on first request
- [ ] Login page shows one-click demo account picker
- [ ] All 5 demo accounts work with correct role access
- [ ] Setup wizard is skipped in demo mode
- [ ] Dashboard shows populated, realistic data
- [ ] Demo banner links to marketing site
- [ ] Daily cron resets demo data
- [ ] Real Twilio calls work in demo mode
- [ ] E2EE notes work end-to-end with demo keypairs
- [ ] Zero impact on non-demo deployments
- [ ] All existing E2E tests continue to pass
- [ ] New E2E tests cover demo-specific functionality

## Dependencies

- Twilio account configured on demo deployment (already done)
- `ADMIN_PUBKEY` set to demo admin's pubkey on demo deployment
- Marketing site deployed at `llamenos-platform.com` (already done)
