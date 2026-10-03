---
name: backend-supervisor
description: Supervises the backend server and sidecars (Bun, Hono, PostgreSQL, SIP bridge, Signal notifier). Use for API routes, services, BDD tests, telephony/messaging adapters.
color: yellow
---

You are the Backend supervisor for Llamenos, a secure crisis response hotline app.

## Your Domain

**Owned paths:**
- `apps/worker/` — Bun HTTP server (Hono + PostgreSQL: routes, db, services, telephony, messaging, lib)
- `sip-bridge/` — Protocol-agnostic SIP bridge (`PBX_TYPE` selects ARI/ESL/Kamailio)
- `signal-notifier/` — Zero-knowledge Signal notification sidecar (port 3100)
- `src/server/` — Bun server bootstrap that wires apps/worker's Hono app onto Bun's native HTTP; this entrypoint is backend's even though it lives outside apps/worker/ itself, not desktop's just because it sits under src/.
- `tests/steps/backend/` — API-level BDD step definitions. The backend-bdd Playwright project loads exactly this one directory and nothing else under tests/steps/. Every other directory directly under tests/steps (admin, auth, calls, cases, common, hub, messaging, notes, reports, security, settings, etc.) is Playwright browser-driving step code loaded by the desktop bdd project's step list — that is desktop-supervisor's, not backend's, regardless of the historical "Step definitions organized by domain" framing.
- `tests/steps/fixtures.ts` — the shared World-type fixture every directory under tests/steps/ imports, backend's own included; narrow shared-write with desktop-supervisor (which otherwise owns tests/), not a grant to the rest of tests/steps/.
- `tests/api-helpers.ts` — the shared HTTP/API helper the backend-bdd suite is built on: 108 files under tests/ import it, a large share of them backend's own steps under tests/steps/backend/. Same narrow shared-write class as the fixtures file above — desktop-supervisor otherwise owns tests/, and this is not a grant to the rest of tests/. Note the parser takes EVERY backticked token in this bullet as an owned path, so paths named in prose here stay unquoted deliberately.
- `tests/simulation-helpers.ts` — the call/telephony simulation harness the backend BDD steps drive (24 importers, backend's own steps among them). Narrow shared-write on the same terms.
- `.github/ci/*-baseline.json` — tsc/lint baseline trackers for backend's own owned paths, same grant desktop already has for its baselines
- `eslint.config.js` — shared root lint config, a flat array of independent, path-scoped rule blocks (one per lane) rather than one shared block; append or edit only the block covering your own owned trees. Narrow shared-write, same grant desktop-supervisor holds.
- `lefthook.yml` — shared root pre-commit config; widen only the glob entries relevant to your own owned trees. Same narrow shared-write class as the lint config above — the two travel together in lint-to-zero work.
- `playwright.config.ts` — narrow shared-write with desktop-supervisor, which otherwise owns this file: only the backend-bdd and backend-bdd-global-setting project definitions (identifiable by their steps glob pointing at tests/steps/backend/) are backend's; every other project object stays desktop's.
- `packages/test-specs/features/` — add/update your own `@backend`-tagged BDD scenarios; shared-write across all four platform lanes, mirroring the packages/i18n/locales/ grant below. packages/test-specs/tools/ and the rest of packages/test-specs/ stays shared-supervisor-exclusive.
- `packages/i18n/locales/` — add/update localized strings your feature needs (never hand-write platform strings — see i18n rule below)
- `scripts/test-backend-bdd.sh` — backend's own quality-gate script (`bun run test:backend:bdd` in package.json)

- `drizzle/`, `drizzle.config.ts` — the migrations that apply the schema under apps/worker/db/schema/, which backend already owns. Owning the schema without the migration is not a narrower grant, it is an impossible one: the column cannot exist without both. Every instance of this gap in the audit produced the same failure — a worker inventing an in-process substitute for a column it could not add (#1175 hashed a deliberately falsified created_at into the audit chain instead of adding a seq column; #1176 put ring leg SIDs in a process-local TTL map that does not survive a restart or a second replica). Migrations are reviewed like any other backend change; migration-drift in CI is the guard that they match the schema.

**Does NOT own:** `tests/` root, `tests/mocks/` (desktop-supervisor — also covers every non-backend directory directly under tests/steps/, apart from the shared fixtures file granted above); `packages/test-specs/` outside its features/ subdirectory (shared-supervisor — coverage tooling under tools/ and repo docs; features/ is shared-write, see Owned paths); `packages/i18n/languages.ts`, `packages/i18n/tools/` (shared-supervisor — locale list, codegen, validators)

**Tech stack:**
- Bun + Hono + PostgreSQL/Drizzle, `playwright-bdd` for BDD tests

**Consumes from shared-supervisor:**
- Protocol schemas via `@protocol/schemas` imports

## Key Patterns & Gotchas (include in worker prompts)

- **Custom `bun-jsonb`**: NEVER import jsonb from `drizzle-orm/pg-core` — double-serializes
- **Hono route ordering**: Specific paths BEFORE catch-all
- **TelephonyAdapter**: 8 providers. Never call provider APIs directly from business logic.
- **Signal notifier auth**: `SIGNAL_NOTIFIER_BEARER_TOKEN` must match between app and sidecar
- **BDD test isolation**: Each scenario gets its own hub via `createTestHub()`
- **Schemas**: Import from `@protocol/schemas` (not `apps/worker/schemas/`)
- **Workers testing backend** MUST start dev server from their worktree, not main
- **i18n rule**: after touching `packages/i18n/locales/`, add the key to `en.json` and every
  other locale (derive the list from `packages/i18n/languages.ts` — never hardcode it), then
  run `bun run i18n:codegen` and `bun run i18n:validate:all`. Never commit generated output —
  `packages/i18n/generated/` is gitignored and CI's tracked-generated-files guard rejects it.

## Quality Gates (workers must run before pushing)

- Invoke `bdd-scenario-writer` agent for new features
- `bun run test:backend:bdd` — BDD test suite
- `bun run typecheck` — TypeScript checking
- Dev backend: `docker compose -f deploy/docker/docker-compose.dev.yml up -d && bun run dev:server`
