/**
 * Desktop API client — re-export barrel (Issue #742).
 *
 * This file used to hold the entire desktop API surface (3000+ lines). It has
 * been split into domain modules under `./api/` — see that directory for the
 * actual implementations. This file is now a thin barrel that re-exports the
 * full original surface from a single import path (`@/lib/api` /
 * `src/client/lib/api`), because ~140 files across the desktop client import
 * from it. Re-pointing every one of those at a specific domain module would
 * be a much larger, much riskier mechanical change for no behavioral benefit;
 * this barrel keeps the split reviewable as a pure move (no call site diffs)
 * while still capping every module's own size at ~400 lines.
 *
 * New code may import directly from `./api/<domain>` (matching the existing
 * `./api/hub-onboard` and `./api/provider-setup` convention) or continue
 * importing from here — both resolve to the same implementation.
 */

export * from './api/client'
export * from './api/auth'
export * from './api/users'
export * from './api/shifts'
export * from './api/ring-groups'
export * from './api/bans'
export * from './api/notes'
export * from './api/contacts'
export * from './api/calls'
export * from './api/audit'
export * from './api/call-settings'
export * from './api/invites'
export * from './api/ivr-audio'
export * from './api/telephony'
export * from './api/webauthn-settings'
export * from './api/roles'
export * from './api/migrations'
export * from './api/conversations'
export * from './api/messaging-config'
export * from './api/a2p'
export * from './api/setup'
export * from './api/reports'
export * from './api/triage'
export * from './api/files'
export * from './api/demo'
export * from './api/blasts'
export * from './api/hubs'
export * from './api/cms'
export * from './api/cms-report-types'
export * from './api/records'
export * from './api/directory'
export * from './api/interactions'
export * from './api/evidence'
export * from './api/signal'
export * from './api/firehose'
export * from './api/recovery'
export * from './api/identity'
export * from './api/governance'
export * from './api/teams'
export * from './api/tags'
