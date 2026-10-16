# Hub Deletion by Crypto-Shred — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deleting a hub destroys its keys, not its rows — irreversibly after a 48-hour undo window, without breaking the Epic 77 audit chain and without touching any other hub's keys.

**Architecture:** Shred is a rotation to a key nobody holds. A single `HUB_SHRED_TARGETS` declaration drives every destructive statement, and each entry is structurally confined to `hub_id = $1` or an FK subquery into a hub-scoped parent, so cross-hub reach is impossible rather than merely tested for. The request, its window, its cancellation and its co-approved force override are rows in the existing `erasure_requests` / `erasure_config` tables, executed by the existing erasure expiry worker.

**Tech Stack:** Bun, Hono, Drizzle ORM, PostgreSQL, Zod→quicktype protocol codegen, Vitest (worker unit + integration), Playwright/Cucumber (backend BDD), `@llamenos/crypto/ffi` (HPKE) and `@noble/curves` for test keypairs.

**Spec:** `docs/superpowers/specs/2026-10-03-hub-deletion-crypto-shred-design.md` — read it before Task 1. §4 is the complete shred set and is normative; this plan implements it.

## Global Constraints

- **Never delete a user, a `puk_envelope`, a `user_role_envelope`, an `audit_user_key`, a `sigchain_link`, a `device`, a `session`, a `webauthn_credential`, a `provision_room`, a `platform_role_envelope`, `roles.encrypted_name`, `user_signal_contacts` or `entity_type_templates`.** These are user- or platform-scoped. Spec §4 "What shred must NOT touch".
- **Never delete an `audit_log` row and never alter `entry_hash` or `previous_entry_hash`.** Spec §4 Class E.
- **Every destructive statement is scoped** `WHERE hub_id = $1` or `WHERE <fk> IN (SELECT id FROM <parent> WHERE hub_id = $1)`. No third shape.
- **A forced shred still requires co-approval.** The override skips the wait, never the second pair of eyes. Spec §14.1.
- **Failure is loud.** No `console.warn` in place of a throw; a partially shredded hub is never reported as `shredded`.
- All user-facing strings go through `packages/i18n/locales/*.json` + `bun run i18n:codegen`. Never edit a platform string file directly.
- Never print a seed, key, token or `DATABASE_URL`.
- Crypto context constants come from `@shared/crypto-labels`. Never a raw string literal.
- Zod fields with defaults use `.optional().default(v)`, never bare `.default(v)`.
- Run `bun run codegen` after any change under `packages/protocol/schemas/`.

## Environment setup (once, before Task 1)

```bash
docker compose -f deploy/docker/docker-compose.dev.yml up -d
bun scripts/worktree-db.ts use-isolated    # this worktree's OWN database
bun scripts/worktree-db.ts status          # confirm mode is "isolated"
```

The shared `llamenos` database is the operator's running server. Never reset it.

## File Structure

| File | Responsibility |
|---|---|
| `apps/worker/services/hub-shred-targets.ts` *(new)* | The `HUB_SHRED_TARGETS` declaration and its types. Data only — no execution. Kept separate so the shape test reads a value, not a side effect. |
| `apps/worker/services/hub-shred.ts` *(new)* | `HubShredService` — executes the targets, deletes blob-store envelope mirrors, asserts completeness. |
| `apps/worker/db/schema/erasure.ts` | `scope` / `hub_id` on `erasure_requests`; `hub_shred_delay_hours` on `erasure_config`; `scope` on `re_encryption_jobs`. |
| `apps/worker/db/schema/settings.ts` | `hubs.hub_key_generation`. |
| `apps/worker/services/erasure.ts` | Hub-scope request lifecycle; DB-clock expiry. |
| `apps/worker/services/settings.ts` | Status transitions; refuse hub-key writes to a shredded hub. |
| `apps/worker/middleware/hub-writable.ts` *(new)* | 409 for writes to a non-`active` hub. |
| `apps/worker/routes/hubs.ts` | `POST/DELETE /:hubId/shred`; `DELETE /:hubId` → shred. |
| `apps/worker/lib/erasure-expiry-worker.ts` | Claim hub-scope requests too. |
| `packages/protocol/schemas/hubs.ts`, `.../erasure.ts` | Status values and request/response shapes. |
| `tests/api-helpers.ts` | `deleteHubViaApi` throws. |
| `apps/worker/__tests__/integration/hub-shred-helpers.ts` *(new)* | `reader()`, `openEnvelope()`, `seedReadableNote()`, `freshHubDb()` — shared by all four shred test files so the decrypt path is written once. |

---

### Task 1: Make hub-deletion failure loud

The in-scope half of #1502. A hub that fails to delete currently looks like one that deleted, which is why the cascade defect survived two releases. Independent of everything else — land it first.

**Files:**
- Modify: `tests/api-helpers.ts:268-277`
- Modify: callers that wrap it in `.catch(() => {})` (enumerate in Step 3)

**Interfaces:**
- Produces: `deleteHubViaApi(request, hubId): Promise<void>` — unchanged signature, now **throws** `Error` on any status other than 200/204.

- [ ] **Step 1: Read every current caller and classify it**

```bash
grep -rn "deleteHubViaApi" tests/ | grep -v "api-helpers.ts"
```

Each call site is one of two kinds. Record which in a scratch note:
- **Teardown of a hub this test created** — must now surface the failure. Remove the `.catch(() => {})`.
- **Best-effort cleanup of a hub that may legitimately not exist** (already deleted by the scenario under test) — keep tolerant, but tolerate *only* 404, by catching and rethrowing anything else.

- [ ] **Step 2: Write the failing test**

Create `apps/worker/__tests__/unit/api-helpers-delete-hub.test.ts`:

```ts
/**
 * deleteHubViaApi must throw on failure (#1502).
 *
 * It used to console.warn, so no suite could observe a hub that would not
 * delete — a success signal indistinguishable from an absent one. This test
 * exists to keep that property from regressing.
 */
import { describe, expect, it } from 'vitest'
import type { APIRequestContext } from '@playwright/test'
import { deleteHubViaApi } from '../../../../tests/api-helpers'

function requestReturning(status: number): APIRequestContext {
  return {
    delete: async () => ({
      status: () => status,
      ok: () => status >= 200 && status < 300,
      text: async () => '',
      json: async () => ({}),
    }),
  } as unknown as APIRequestContext
}

describe('deleteHubViaApi', () => {
  it('resolves when the hub is deleted', async () => {
    await expect(deleteHubViaApi(requestReturning(200), 'hub-1')).resolves.toBeUndefined()
  })

  it('throws when the server refuses the delete', async () => {
    await expect(deleteHubViaApi(requestReturning(500), 'hub-1'))
      .rejects.toThrow(/hub-1/)
  })

  it('throws on a 409 — a hub that will not delete is not a hub that deleted', async () => {
    await expect(deleteHubViaApi(requestReturning(409), 'hub-1')).rejects.toThrow()
  })
})
```

- [ ] **Step 3: Run it and watch it fail**

Run: `bunx vitest run apps/worker/__tests__/unit/api-helpers-delete-hub.test.ts`
Expected: the two throw cases FAIL — the helper resolves instead.

- [ ] **Step 4: Make the helper throw**

Replace `tests/api-helpers.ts:268-277` with:

```ts
export async function deleteHubViaApi(
  request: APIRequestContext,
  hubId: string,
): Promise<void> {
  const { status } = await apiDelete(request, `/hubs/${hubId}`)
  if (status !== 200 && status !== 204) {
    // Loud on purpose (#1502): swallowing this made a hub that would not
    // delete indistinguishable from one that did, for two releases.
    throw new Error(`Failed to delete hub ${hubId}: ${status}`)
  }
}
```

- [ ] **Step 5: Fix the callers classified in Step 1**

For teardown of a hub the test created, drop the `.catch(() => {})` entirely. For genuinely best-effort cleanup, be explicit:

```ts
await deleteHubViaApi(request, hubId).catch((err: unknown) => {
  if (!String(err).includes(': 404')) throw err
})
```

- [ ] **Step 6: Run the unit test and the backend BDD suite**

```bash
bunx vitest run apps/worker/__tests__/unit/api-helpers-delete-hub.test.ts
bun run test:backend:bdd
```
Expected: both pass. If BDD now fails, a hub genuinely was not deleting — that is the defect becoming visible, which is the point. Investigate before weakening anything.

- [ ] **Step 7: Commit**

```bash
git add tests/api-helpers.ts apps/worker/__tests__/unit/api-helpers-delete-hub.test.ts tests/steps/
git commit -m "fix(tests): deleteHubViaApi throws instead of console.warn (#1502)"
```

---

### Task 2: Schema and migration

**Files:**
- Modify: `apps/worker/db/schema/erasure.ts`
- Modify: `apps/worker/db/schema/settings.ts:72` (hubs)
- Create: `drizzle/migrations/<generated>.sql`
- Test: `apps/worker/__tests__/integration/hub-shred-schema.test.ts`

**Interfaces:**
- Produces: `erasureRequests.scope: 'user' | 'hub'`, `erasureRequests.hubId: string | null`, `erasureRequests.userId: string | null`, `erasureRequests.previousStatus: string | null`; `erasureConfig.hubShredDelayHours: number`; `reEncryptionJobs.scope: 'user' | 'hub'`, `reEncryptionJobs.userId: string | null`; `hubs.hubKeyGeneration: number`.

- [ ] **Step 1: Write the failing schema test**

Create `apps/worker/__tests__/integration/hub-shred-schema.test.ts` using the real-Postgres pattern from `apps/worker/__tests__/integration/invite-hub-membership.test.ts` (copy its `beforeAll`/`afterAll` verbatim, changing `DB_NAME` to `hub_shred_schema_...`). Body:

```ts
describe('erasure_requests carries hub scope', () => {
  it('accepts a hub-scoped request', async () => {
    const [row] = await db.insert(schema.erasureRequests).values({
      scope: 'hub',
      hubId: 'hub-a',
      userId: null,
      requestedBy: 'admin-pk',
      executeAt: new Date(Date.now() + 48 * 3600_000),
    }).returning()
    expect(row.scope).toBe('hub')
    expect(row.hubId).toBe('hub-a')
    expect(row.userId).toBeNull()
  })

  it('refuses a hub-scoped request that also names a user', async () => {
    await expect(db.insert(schema.erasureRequests).values({
      scope: 'hub', hubId: 'hub-b', userId: 'user-pk',
      requestedBy: 'admin-pk', executeAt: new Date(),
    })).rejects.toThrow(/erasure_requests_scope_subject/)
  })

  it('refuses a user-scoped request with no user', async () => {
    await expect(db.insert(schema.erasureRequests).values({
      scope: 'user', hubId: null, userId: null,
      requestedBy: 'admin-pk', executeAt: new Date(),
    })).rejects.toThrow(/erasure_requests_scope_subject/)
  })

  it('defaults the hub shred window to 48 hours', async () => {
    const [cfg] = await db.insert(schema.erasureConfig)
      .values({ hubId: 'hub-c', updatedBy: 'admin-pk' }).returning()
    expect(cfg.hubShredDelayHours).toBe(48)
    expect(cfg.delayHours).toBe(72) // the user-erasure window is unchanged
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bunx vitest run --config vitest.integration.config.ts apps/worker/__tests__/integration/hub-shred-schema.test.ts`
Expected: FAIL — `scope` is not a column.

- [ ] **Step 3: Edit the drizzle schema**

In `apps/worker/db/schema/erasure.ts`, inside `erasureRequests`:

```ts
    /** 'user' — a person's right to erasure. 'hub' — a hub crypto-shred. */
    scope: text('scope').notNull().default('user'),
    /** Set for scope='user'. Null for scope='hub'. */
    userId: text('user_id'),
    /** Set for scope='hub'. Null for scope='user'. */
    hubId: text('hub_id'),
    /**
     * The hub's status before the shred was scheduled, so a cancel inside the
     * window restores exactly what was there rather than guessing 'active'.
     * Null for scope='user'.
     */
    previousStatus: text('previous_status'),
```

and in its config array:

```ts
    index('erasure_requests_hub_id_idx').on(table.hubId),
    check(
      'erasure_requests_scope_subject',
      sql`(scope = 'user' AND user_id IS NOT NULL AND hub_id IS NULL)
       OR (scope = 'hub'  AND hub_id  IS NOT NULL AND user_id IS NULL)`,
    ),
```

Import `check` and `sql`. In `erasureConfig` add:

```ts
  /**
   * Undo window for a hub crypto-shred, separate from delayHours (which is a
   * person's erasure delay). Same platform floor applies.
   */
  hubShredDelayHours: integer('hub_shred_delay_hours').notNull().default(48),
```

In `reEncryptionJobs` make `userId` nullable and add `scope: text('scope').notNull().default('user')`.

In `apps/worker/db/schema/settings.ts`, in `hubs`, after `createdBy`:

```ts
  /**
   * Generation of the hub key that `hub_keys` currently wraps. 0 = no key.
   * Only ever moves forward, and only in the transaction that replaces the
   * envelopes — so a write carrying an older generation is refused, and a
   * shredded key can never be re-installed by a replayed envelope write.
   */
  hubKeyGeneration: integer('hub_key_generation').notNull().default(0),
```

> If `origin/fix-1042` has landed by now, `hub_key_generation` already exists — skip that edit and keep its column comment.

- [ ] **Step 4: Generate and apply the migration**

```bash
bunx drizzle-kit generate
bun scripts/run-migrations.ts
```
Read the generated SQL before applying. It must be additive only: no `DROP`, and the `user_id` change must be `ALTER COLUMN ... DROP NOT NULL`, never a drop-and-recreate.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bunx vitest run --config vitest.integration.config.ts apps/worker/__tests__/integration/hub-shred-schema.test.ts`
Expected: PASS, all four.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/db/schema/ drizzle/migrations/ apps/worker/__tests__/integration/hub-shred-schema.test.ts
git commit -m "feat(db): extend erasure_requests to hub scope and add the hub shred window"
```

---

### Task 3: `HUB_SHRED_TARGETS` and the structural isolation invariant

The heart of the design. Build the declaration and the test that makes cross-hub reach impossible **before** anything executes it.

**Files:**
- Create: `apps/worker/services/hub-shred-targets.ts`
- Test: `apps/worker/__tests__/unit/hub-shred-targets.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type HubShredTarget =
    | { kind: 'clear-envelopes'; table: string; columns: Record<string, "'[]'::jsonb" | 'NULL'>; scope: HubScope }
    | { kind: 'delete-rows';     table: string; scope: HubScope }
    | { kind: 'audit-shred' }
  type HubScope =
    | { via: 'hub-id'; column?: string }
    | { via: 'parent'; fk: string; parentTable: string }
  export const HUB_SHRED_TARGETS: readonly HubShredTarget[]
  export const CROSS_HUB_TABLES: readonly string[]
  ```

- [ ] **Step 1: Write the failing invariant test**

Create `apps/worker/__tests__/unit/hub-shred-targets.test.ts`:

```ts
/**
 * Hub isolation is a property of the declaration, not of reviewer attention.
 *
 * A user belongs to many hubs and their PUK is shared across all of them, so a
 * shred of hub A that reaches a user-scoped table locks that user out of hub B.
 * These tests make that unrepresentable: every target must be confined to one
 * hub, and no target may name a table that is not hub-scoped.
 */
import { describe, expect, it } from 'vitest'
import { HUB_SHRED_TARGETS, CROSS_HUB_TABLES } from '../../services/hub-shred-targets'

describe('HUB_SHRED_TARGETS', () => {
  it('confines every target to a single hub', () => {
    for (const target of HUB_SHRED_TARGETS) {
      if (target.kind === 'audit-shred') continue
      expect(['hub-id', 'parent'], `${target.table} has an unrecognised scope`)
        .toContain(target.scope.via)
      if (target.scope.via === 'parent') {
        expect(target.scope.parentTable, `${target.table} has no parent table`).toBeTruthy()
        expect(target.scope.fk, `${target.table} has no foreign key`).toBeTruthy()
      }
    }
  })

  it('names no cross-hub table', () => {
    const named = HUB_SHRED_TARGETS
      .filter(t => t.kind !== 'audit-shred')
      .map(t => (t as { table: string }).table)
    for (const forbidden of CROSS_HUB_TABLES) {
      expect(named, `${forbidden} is user- or platform-scoped and must never be shredded for a hub`)
        .not.toContain(forbidden)
    }
  })

  it('lists every cross-hub table the spec forbids', () => {
    // Spec §4 "What shred must NOT touch". Adding a table here is cheap;
    // forgetting one is how hub B's user loses access.
    expect([...CROSS_HUB_TABLES].sort()).toEqual([
      'audit_user_keys', 'devices', 'entity_type_templates',
      'platform_role_envelopes', 'provision_rooms', 'puk_envelopes',
      'roles', 'sessions', 'sigchain_links', 'user_role_envelopes',
      'user_signal_contacts', 'users', 'webauthn_credentials',
    ])
  })

  it('declares exactly one audit-shred step', () => {
    expect(HUB_SHRED_TARGETS.filter(t => t.kind === 'audit-shred')).toHaveLength(1)
  })

  it('names each table at most once', () => {
    const named = HUB_SHRED_TARGETS
      .filter(t => t.kind !== 'audit-shred')
      .map(t => (t as { table: string }).table)
    expect(new Set(named).size, 'a table declared twice is a target edited in one place only')
      .toBe(named.length)
  })

  it('covers every class in spec §4', () => {
    const named = new Set(HUB_SHRED_TARGETS
      .filter(t => t.kind !== 'audit-shred')
      .map(t => (t as { table: string }).table))
    for (const required of [
      // A — the hub key's own wraps
      'hub_keys',
      // B — per-row recipient envelopes
      'notes', 'note_replies', 'call_records', 'messages', 'files',
      'contact_identifiers', 'case_records', 'case_interactions', 'evidence',
      'report_cases', 'events', 'contacts', 'contact_relationships', 'affinity_groups',
      // C — server-sealed hub rows
      'hub_storage_credentials', 'provider_configs', 'firehose_connections', 'subscribers',
      // D — key-recovery paths
      'hub_recovery_groups', 'hub_recovery_group_shares', 'user_recovery_envelopes',
      'recovery_sessions', 'mls_pending_messages',
      // F — hub bearer tokens
      'call_tokens', 'invite_codes',
    ]) {
      expect(named, `${required} is in the spec's shred set but not in HUB_SHRED_TARGETS`).toContain(required)
    }
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bunx vitest run apps/worker/__tests__/unit/hub-shred-targets.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the declaration**

Create `apps/worker/services/hub-shred-targets.ts`. Full content:

```ts
/**
 * The complete shred set for a hub — spec §4.
 *
 * Declaration only: no statement is built here. Every entry is confined to one
 * hub by construction, because `HubScope` admits exactly two shapes and the
 * executor can build nothing else from it. That is what makes "a shred of hub A
 * cannot reach hub B" a property rather than a review note: a user belongs to
 * many hubs and their PUK is shared across all of them.
 */

/** How a table's rows are attributed to one hub. There is no third shape. */
export type HubScope =
  /** The table has its own hub column. */
  | { via: 'hub-id'; column?: string }
  /** The table is reached through a parent that has one. */
  | { via: 'parent'; fk: string; parentTable: string }

export type HubShredTarget =
  /**
   * Destroy the wraps, keep the row and its ciphertext. The content key becomes
   * unrecoverable by anyone, including us.
   */
  | {
      kind: 'clear-envelopes'
      table: string
      /** column → the value that destroys it. */
      columns: Record<string, "'[]'::jsonb" | 'NULL'>
      scope: HubScope
    }
  /** The sealing key is global or the row *is* the key material: delete it. */
  | { kind: 'delete-rows'; table: string; scope: HubScope }
  /** audit_log: null the content, keep every hash. Handled specially. */
  | { kind: 'audit-shred' }

const BY_HUB: HubScope = { via: 'hub-id' }
const VIA_CONVERSATION: HubScope = { via: 'parent', fk: 'conversation_id', parentTable: 'conversations' }
const VIA_CASE: HubScope = { via: 'parent', fk: 'case_id', parentTable: 'case_records' }

/**
 * User- and platform-scoped tables. A hub shred must never name one.
 *
 * `puk_envelopes` is keyed (user_pubkey, device_id) and `user_role_envelopes`
 * (user_pubkey, role_id) with `roles` global — neither has a hub column, so
 * deleting either to shred hub A would lock the same user out of hub B. They
 * are correctly destroyed by *user* erasure, which is a different scope.
 */
export const CROSS_HUB_TABLES = [
  'audit_user_keys',
  'devices',
  'entity_type_templates',
  'platform_role_envelopes',
  'provision_rooms',
  'puk_envelopes',
  'roles',
  'sessions',
  'sigchain_links',
  'user_role_envelopes',
  'user_signal_contacts',
  'users',
  'webauthn_credentials',
] as const

export const HUB_SHRED_TARGETS: readonly HubShredTarget[] = [
  // --- Class A: the hub key's own wraps -----------------------------------
  // The hub key is random bytes that exist nowhere else server-side. Deleting
  // every wrap ends it. The executor also bumps hubs.hub_key_generation, or a
  // replayed PUT /hubs/:id/key would re-install it.
  { kind: 'delete-rows', table: 'hub_keys', scope: BY_HUB },

  // --- Class B: per-row recipient envelopes -------------------------------
  // There is no items_key table: each row's content key is HPKE-wrapped
  // directly to each reader. These columns ARE the shred.
  { kind: 'clear-envelopes', table: 'notes', scope: BY_HUB,
    columns: { author_envelope: "'[]'::jsonb", admin_envelopes: "'[]'::jsonb", field_envelopes: 'NULL' } },
  { kind: 'clear-envelopes', table: 'note_replies',
    scope: { via: 'parent', fk: 'note_id', parentTable: 'notes' },
    columns: { reader_envelopes: "'[]'::jsonb" } },
  { kind: 'clear-envelopes', table: 'call_records', scope: BY_HUB,
    columns: { admin_envelopes: "'[]'::jsonb" } },
  { kind: 'clear-envelopes', table: 'messages', scope: VIA_CONVERSATION,
    columns: { reader_envelopes: "'[]'::jsonb" } },
  // files: the blob-store mirror at files/<id>/envelopes is deleted by the
  // executor. Clearing this column alone leaves a usable wrap in RustFS.
  { kind: 'clear-envelopes', table: 'files', scope: VIA_CONVERSATION,
    columns: { recipient_envelopes: "'[]'::jsonb", encrypted_metadata: "'[]'::jsonb" } },
  // Sealed with a server HMAC secret, not a reader envelope: clearing the
  // column is the only way to destroy it.
  { kind: 'clear-envelopes', table: 'contact_identifiers', scope: VIA_CONVERSATION,
    columns: { encrypted_identifier: 'NULL' } },
  { kind: 'clear-envelopes', table: 'case_records', scope: BY_HUB,
    columns: { summary_envelopes: "'[]'::jsonb", field_envelopes: "'[]'::jsonb", pii_envelopes: "'[]'::jsonb" } },
  { kind: 'clear-envelopes', table: 'case_interactions', scope: VIA_CASE,
    columns: { content_envelopes: "'[]'::jsonb" } },
  { kind: 'clear-envelopes', table: 'evidence', scope: VIA_CASE,
    columns: { description_envelopes: "'[]'::jsonb" } },
  { kind: 'clear-envelopes', table: 'report_cases', scope: VIA_CASE,
    columns: { notes_envelopes: "'[]'::jsonb" } },
  { kind: 'clear-envelopes', table: 'events', scope: BY_HUB,
    columns: { detail_envelopes: "'[]'::jsonb" } },
  { kind: 'clear-envelopes', table: 'contacts', scope: BY_HUB,
    columns: { summary_envelopes: "'[]'::jsonb", pii_envelopes: "'[]'::jsonb" } },
  { kind: 'clear-envelopes', table: 'contact_relationships', scope: BY_HUB,
    columns: { notes_envelopes: "'[]'::jsonb" } },
  { kind: 'clear-envelopes', table: 'affinity_groups', scope: BY_HUB,
    columns: { detail_envelopes: "'[]'::jsonb" } },

  // --- Class C: server-sealed hub data ------------------------------------
  // The sealing key is global, so the row itself must go.
  { kind: 'delete-rows', table: 'hub_storage_credentials', scope: BY_HUB },
  { kind: 'delete-rows', table: 'provider_configs', scope: BY_HUB },
  { kind: 'delete-rows', table: 'signal_registrations', scope: BY_HUB },
  { kind: 'delete-rows', table: 'a2p_registrations', scope: BY_HUB },
  // The agent seal key is the root above every per-window content key.
  { kind: 'delete-rows', table: 'firehose_message_buffer',
    scope: { via: 'parent', fk: 'connection_id', parentTable: 'firehose_connections' } },
  { kind: 'delete-rows', table: 'firehose_window_keys',
    scope: { via: 'parent', fk: 'connection_id', parentTable: 'firehose_connections' } },
  { kind: 'delete-rows', table: 'firehose_connections', scope: BY_HUB },
  { kind: 'clear-envelopes', table: 'subscribers', scope: BY_HUB,
    columns: { encrypted_identifier: 'NULL' } },

  // --- Class D: key-recovery paths ----------------------------------------
  // Destroying hub_keys while leaving these behind is not a shred: a threshold
  // of share holders reconstructs the hub recovery secret.
  { kind: 'delete-rows', table: 'hub_recovery_group_shares', scope: BY_HUB },
  { kind: 'delete-rows', table: 'hub_recovery_groups', scope: BY_HUB },
  { kind: 'delete-rows', table: 'user_recovery_envelopes', scope: BY_HUB },
  { kind: 'delete-rows', table: 'recovery_session_contributions',
    scope: { via: 'parent', fk: 'session_id', parentTable: 'recovery_sessions' } },
  { kind: 'delete-rows', table: 'recovery_sessions', scope: BY_HUB },
  // MLS KeyPackages and Welcomes: epoch secrets derive the SFrame media keys.
  { kind: 'delete-rows', table: 'mls_pending_messages', scope: BY_HUB },

  // --- Class E: audit -----------------------------------------------------
  { kind: 'audit-shred' },

  // --- Class F: hub bearer tokens -----------------------------------------
  { kind: 'delete-rows', table: 'call_tokens', scope: BY_HUB },
  { kind: 'delete-rows', table: 'invite_codes', scope: BY_HUB },
] as const
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run apps/worker/__tests__/unit/hub-shred-targets.test.ts`
Expected: PASS, all six.

- [ ] **Step 5: Verify every named table and column actually exists**

Add to the same test file:

```ts
import * as schema from '../../db/schema'

it('names only real tables and real columns', () => {
  const tables = new Map<string, Set<string>>()
  for (const value of Object.values(schema)) {
    const table = value as { _?: { name?: string; columns?: Record<string, { name: string }> } }
    const name = table?._?.name
    if (!name || !table._?.columns) continue
    tables.set(name, new Set(Object.values(table._.columns).map(c => c.name)))
  }
  for (const target of HUB_SHRED_TARGETS) {
    if (target.kind === 'audit-shred') continue
    const columns = tables.get(target.table)
    expect(columns, `no such table: ${target.table}`).toBeDefined()
    if (target.scope.via === 'parent') {
      expect(columns!, `${target.table}.${target.scope.fk} does not exist`).toContain(target.scope.fk)
      expect(tables.get(target.scope.parentTable), `no such parent: ${target.scope.parentTable}`).toBeDefined()
      expect(tables.get(target.scope.parentTable)!, `${target.scope.parentTable} has no hub_id`).toContain('hub_id')
    } else {
      expect(columns!, `${target.table} has no hub_id`).toContain(target.scope.column ?? 'hub_id')
    }
    if (target.kind === 'clear-envelopes') {
      for (const column of Object.keys(target.columns)) {
        expect(columns!, `${target.table}.${column} does not exist`).toContain(column)
      }
    }
  }
})
```

Run it. **If it fails, the declaration is wrong, not the test** — fix the table or column name against `apps/worker/db/schema/`. This is the check that catches a typo'd column silently shredding nothing.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/services/hub-shred-targets.ts apps/worker/__tests__/unit/hub-shred-targets.test.ts
git commit -m "feat(shred): declare the hub shred set with hub isolation as a checked invariant"
```

---

### Task 4: The shred executor

**Files:**
- Create: `apps/worker/services/hub-shred.ts`
- Test: `apps/worker/__tests__/integration/hub-shred-execute.test.ts`

**Interfaces:**
- Consumes: `HUB_SHRED_TARGETS`, `HubShredTarget`, `HubScope` from Task 3.
- Produces:
  ```ts
  class HubShredService {
    constructor(db: Database, blobStorage?: { delete(key: string): Promise<void> })
    execute(hubId: string, executedBy: string, audit: AuditService): Promise<{ rowsAffected: number }>
    verifyShredded(hubId: string): Promise<{ complete: true } | { complete: false; residue: string[] }>
  }
  ```

- [ ] **Step 1: Create the shared test helper**

Tasks 4, 5, 6 and 7 all need the same real decrypt path. Write it once in
`apps/worker/__tests__/integration/hub-shred-helpers.ts` and import it everywhere —
a second copy is a second chance to assert the wrong thing.

It exports:

```ts
/** A real X25519 keypair — the same primitive the Rust DHKEM uses. */
export function reader(): { secret: Uint8Array; pubkey: string }

/** The real decrypt path: unwrap the content key out of an HPKE envelope. */
export function openEnvelope(secret: Uint8Array, env: { enc: string; ct: string }): Uint8Array

/** Unwrap AND open, returning the plaintext. Throws if either step fails. */
export function readSealed(secret: Uint8Array, env: { enc: string; ct: string }, encryptedContent: string): string

/** Seed a note whose author and admin can both genuinely decrypt it. */
export function seedReadableNote(db: Database, hubId: string, author?: ReturnType<typeof reader>):
  Promise<{ note: typeof notes.$inferSelect; author: ReturnType<typeof reader>; admin: ReturnType<typeof reader>; plaintext: string }>

/** beforeAll/afterAll pair: own database, real migrations, dropped on teardown. */
export function freshHubDb(name: string): { db: () => Database; setup: () => Promise<void>; teardown: () => Promise<void> }
```

- [ ] **Step 2: Write the failing executor test**

Create `apps/worker/__tests__/integration/hub-shred-execute.test.ts`, using `freshHubDb('hub_shred_execute')` (which wraps the `beforeAll`/`afterAll` pattern from `invite-hub-membership.test.ts`). Seed with real crypto:

```ts
import { encryptMessageForStorage } from '../../lib/crypto'
import { reader, openEnvelope } from './hub-shred-helpers'

it('destroys the note content key so neither admin nor author can read it', async () => {
  const author = reader()
  const admin = reader()
  const hubId = await createHub()
  const sealed = encryptMessageForStorage('caller disclosed an address', [author.pubkey, admin.pubkey])
  const [note] = await db.insert(schema.notes).values({
    hubId, authorPubkey: author.pubkey,
    encryptedContent: sealed.encryptedContent,
    authorEnvelope: sealed.readerEnvelopes[0],
    adminEnvelopes: [sealed.readerEnvelopes[1]],
  }).returning()

  // Before: both can really decrypt. Without this the test proves nothing.
  const before = await db.select().from(schema.notes).where(eq(schema.notes.id, note.id))
  expect(() => openEnvelope(author.secret, before[0].authorEnvelope as never)).not.toThrow()
  expect(() => openEnvelope(admin.secret, (before[0].adminEnvelopes as never[])[0])).not.toThrow()

  await shred.execute(hubId, 'admin-pk', audit)

  const after = await db.select().from(schema.notes).where(eq(schema.notes.id, note.id))
  expect(after[0].encryptedContent, 'the row and its ciphertext must survive — this is a shred, not a purge')
    .toBe(sealed.encryptedContent)
  expect(after[0].authorEnvelope).toEqual([])
  expect(after[0].adminEnvelopes).toEqual([])
  // No envelope survives anywhere, so there is nothing left to open.
  expect(await shred.verifyShredded(hubId)).toEqual({ complete: true })
})
```

- [ ] **Step 3: Run it and watch it fail**

Run: `bunx vitest run --config vitest.integration.config.ts apps/worker/__tests__/integration/hub-shred-execute.test.ts`
Expected: FAIL — `hub-shred` module not found.

- [ ] **Step 4: Write the executor**

Create `apps/worker/services/hub-shred.ts`. The whole statement builder is these two functions — nothing else may build a predicate:

```ts
import { sql } from 'drizzle-orm'
import type { Database } from '../db'
import { HUB_SHRED_TARGETS, type HubScope, type HubShredTarget } from './hub-shred-targets'
import type { AuditService } from './audit'
import { ServiceError } from './settings'
import { createLogger } from '../lib/logger'

const logger = createLogger('services.hub-shred')

/**
 * The ONLY predicate a shred may use. Both branches bind the hub id as a
 * parameter, and there is no branch that does not mention it — so no statement
 * this service issues can reach a row belonging to another hub.
 */
function scopePredicate(scope: HubScope, hubId: string) {
  if (scope.via === 'hub-id') {
    return sql`${sql.identifier(scope.column ?? 'hub_id')} = ${hubId}`
  }
  return sql`${sql.identifier(scope.fk)} IN (
    SELECT id FROM ${sql.identifier(scope.parentTable)} WHERE hub_id = ${hubId}
  )`
}
```

`execute` runs one transaction:
1. For each `clear-envelopes` target, `UPDATE <table> SET <col> = <value>, ... WHERE <scopePredicate>` — build the SET list from `target.columns`, where the value is injected with `sql.raw` **only** because the type admits exactly the two literals `'[]'::jsonb` and `NULL`. Add a runtime guard rejecting anything else, so the type is not the only thing standing between this and an injection.
2. For each `delete-rows` target, `DELETE FROM <table> WHERE <scopePredicate>`. Order matters: children before parents, which `HUB_SHRED_TARGETS` already encodes (`firehose_message_buffer` and `firehose_window_keys` before `firehose_connections`; `recovery_session_contributions` before `recovery_sessions`; `hub_recovery_group_shares` before `hub_recovery_groups`).
3. The `audit-shred` step, exactly:
   ```sql
   UPDATE audit_log
      SET details = NULL, actor_pubkey = '[shredded]', erased_at = NOW()
    WHERE hub_id = ${hubId} AND erased_at IS NULL
   ```
   Never touch `entry_hash` or `previous_entry_hash`.
4. Bump the key generation and set the terminal status:
   ```sql
   UPDATE hubs SET hub_key_generation = hub_key_generation + 1,
                   status = 'shredded', updated_at = NOW()
    WHERE id = ${hubId}
   ```
5. Filter the hub out of every remaining user's `hub_roles`, reusing `purgeHub`'s step-2 statement verbatim. **Do not** reuse its step 1 — shred never deletes a user.
6. Call `verifyShredded`; throw `ServiceError(500, ...)` if it reports residue, which rolls the transaction back.
7. Append `hubShredded` to the **platform** chain (`audit.log(...)` with no hubId) inside the transaction.

After the transaction commits, delete the blob-store mirrors — outside, because object storage is not transactional:

```ts
/**
 * routes/uploads.ts mirrors every file's envelopes into object storage. The
 * database column is not the only copy: clearing it alone leaves a fully usable
 * wrap in RustFS, so the shred would be a lie.
 */
private async deleteBlobEnvelopeMirrors(hubId: string, fileIds: string[]): Promise<void> {
  for (const id of fileIds) {
    await this.blobStorage?.delete(`files/${id}/envelopes`)
    await this.blobStorage?.delete(`files/${id}/metadata`)
  }
}
```

Collect `fileIds` **before** the transaction (the scope predicate still resolves then) and record a `blob_mirror_pending` marker so a crash between commit and mirror deletion is retried rather than lost; the expiry worker retries it. If the blob store is absent, throw — a shred that cannot reach the mirrors must not report success.

`verifyShredded` re-derives its queries from the same `HUB_SHRED_TARGETS` and returns the list of `table.column` entries still holding a non-empty envelope, plus `hub_keys` if any row remains. This is the completeness assertion, mirroring `assertCoversExactly` in `origin/fix-1042`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bunx vitest run --config vitest.integration.config.ts apps/worker/__tests__/integration/hub-shred-execute.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the message, recording and blob-mirror cases to the same file**

Three more `it(...)` blocks, each following the before/after shape of Step 1:
- a `conversations` + `messages` row sealed to a reader, read back through `openEnvelope`;
- a `call_records` row sealed with `encryptCallRecordForStorage`, likewise;
- a `files` row whose envelopes are also written to a fake blob store, asserting **both** the column is cleared and `blobStore.delete` was called with `files/<id>/envelopes` and `files/<id>/metadata`.

- [ ] **Step 7: Run the whole file and commit**

```bash
bunx vitest run --config vitest.integration.config.ts apps/worker/__tests__/integration/hub-shred-execute.test.ts
git add apps/worker/services/hub-shred.ts apps/worker/__tests__/integration/
git commit -m "feat(shred): execute the hub shred set, including the blob-store envelope mirrors"
```

---

### Task 5: Hub isolation, audit chain and erasure orthogonality

Three properties that must hold, proved before the lifecycle is built on top.

**Files:**
- Test: `apps/worker/__tests__/integration/hub-shred-isolation.test.ts`

- [ ] **Step 1: Write the isolation test**

```ts
/**
 * A user is a member of hub A and hub B and their PUK is shared across both.
 * Shredding A must leave B completely intact — this is the sharpest hazard in
 * the whole feature.
 */
it('leaves the same user\'s access to another hub completely intact', async () => {
  const user = reader()
  const hubA = await createHub()
  const hubB = await createHub()
  const noteA = await seedNote(hubA, user)
  const noteB = await seedNote(hubB, user)

  const pukBefore = await db.select().from(schema.pukEnvelopes)
  const rolesBefore = await db.select().from(schema.userRoleEnvelopes)
  const auditKeysBefore = await db.select().from(schema.auditUserKeys)
  const hubKeysBBefore = await db.select().from(schema.hubKeys)
    .where(eq(schema.hubKeys.hubId, hubB))

  await shred.execute(hubA, 'admin-pk', audit)

  // The user can still really decrypt their hub B note, end to end.
  const [after] = await db.select().from(schema.notes).where(eq(schema.notes.id, noteB.id))
  const key = openEnvelope(user.secret, after.authorEnvelope as never)
  expect(new TextDecoder().decode(symmetricDecrypt(
    key, hexToBytes(after.encryptedContent), new TextEncoder().encode(LABEL_MESSAGE),
  ))).toBe('hub B note')

  // And nothing user-scoped moved.
  expect(await db.select().from(schema.pukEnvelopes)).toEqual(pukBefore)
  expect(await db.select().from(schema.userRoleEnvelopes)).toEqual(rolesBefore)
  expect(await db.select().from(schema.auditUserKeys)).toEqual(auditKeysBefore)
  expect(await db.select().from(schema.hubKeys).where(eq(schema.hubKeys.hubId, hubB)))
    .toEqual(hubKeysBBefore)

  // The user still exists, keeps hub B, and lost only hub A.
  const [u] = await db.select().from(schema.users).where(eq(schema.users.pubkey, user.pubkey))
  expect(u, 'shred must never delete a user').toBeDefined()
  expect((u.hubRoles as { hubId: string }[]).map(r => r.hubId)).toEqual([hubB])

  // Hub A's note is unreadable.
  const [gone] = await db.select().from(schema.notes).where(eq(schema.notes.id, noteA.id))
  expect(gone.authorEnvelope).toEqual([])
})
```

- [ ] **Step 2: Write the audit-chain test**

```ts
it('leaves the hub audit chain valid and the platform chain untouched', async () => {
  const hubId = await createHub()
  for (const action of ['callAnswered', 'noteCreated', 'userAdded']) {
    await audit.log(action, 'actor-pk', { detail: 'sensitive' }, undefined, hubId)
  }
  const before = await audit.verifyFullChain(hubId)
  expect(before.valid).toBe(true)
  expect(before.totalEntries).toBe(3)

  await shred.execute(hubId, 'admin-pk', audit)

  const after = await audit.verifyFullChain(hubId)
  expect(after.valid, 'shredding broke the hash chain').toBe(true)
  expect(after.totalEntries, 'shred deleted an audit row').toBe(3)

  const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.hubId, hubId))
  for (const row of rows) {
    expect(row.details).toBeNull()
    expect(row.actorPubkey).toBe('[shredded]')
    expect(row.erasedAt).not.toBeNull()
    expect(row.entryHash, 'the hash is the commitment — it must survive').toBeTruthy()
  }

  // The platform chain stays valid and records that this happened.
  const platform = await audit.verifyFullChain(undefined)
  expect(platform.valid).toBe(true)
  const [entry] = await db.select().from(schema.auditLog)
    .where(and(isNull(schema.auditLog.hubId), eq(schema.auditLog.action, 'hubShredded')))
  expect(entry, 'the shred itself was not recorded on the platform chain').toBeDefined()
})
```

- [ ] **Step 3: Write the orthogonality test (spec §6.2)**

A volunteer's right to erasure cannot be satisfied by deleting a hub, and a shred
must not silently orphan an in-flight erasure request.

```ts
it('neither satisfies nor orphans a pending user erasure', async () => {
  const user = reader()
  const hubId = await createHub()
  await seedReadableNote(db, hubId, user)
  const request = await erasure.createSelfRequest(user.pubkey, hubId)

  await shred.execute(hubId, 'admin-pk', audit)

  // The person's request survives the hub, untouched and still scheduled.
  const [after] = await db.select().from(schema.erasureRequests)
    .where(eq(schema.erasureRequests.id, request.id))
  expect(after.status, 'a hub shred must not satisfy a person\'s erasure').toBe('pending')
  expect(after.cancelledAt).toBeNull()
  expect(after.executeAt.getTime()).toBe(request.executeAt.getTime())

  // And it still executes cleanly afterwards — removal is idempotent, so the
  // two operations commute on every row they share.
  await expect(erasure.executeErasure(user.pubkey, 'system', 'scheduled', audit))
    .resolves.toBeDefined()
})

it('completes a re-encryption job targeting a shredded hub as a no-op', async () => {
  const hubId = await createHub()
  const user = reader()
  await shred.execute(hubId, 'admin-pk', audit)
  const [job] = await db.insert(schema.reEncryptionJobs)
    .values({ userId: user.pubkey, hubId, status: 'queued' }).returning()

  await erasure.processReEncryptionJob(job.id)

  const [done] = await db.select().from(schema.reEncryptionJobs)
    .where(eq(schema.reEncryptionJobs.id, job.id))
  expect(done.status, 'a job against a shredded hub must complete, not stall').toBe('completed')
})
```

Implement the no-op branch in `processReEncryptionJob`: if the hub's status is
`shredded`, set the job to `completed` and return before issuing any UPDATE.

- [ ] **Step 4: Run all of them, fix the executor until they pass**

Run: `bunx vitest run --config vitest.integration.config.ts apps/worker/__tests__/integration/hub-shred-isolation.test.ts`
Expected: PASS. If the chain test fails, the executor is touching a hash — it must not.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/services/erasure.ts apps/worker/__tests__/integration/hub-shred-isolation.test.ts
git commit -m "test(shred): prove hub isolation, audit-chain survival and erasure orthogonality"
```

---

### Task 6: Verify by breaking it

If removing a member of the shred set does not turn a test red, the tests are asserting the wrong thing. This task runs five deliberate mutations and confirms each one is caught. **Nothing here is committed as a code change** — the deliverable is the evidence plus one new test for any mutation that slipped through.

**Files:**
- Test: whichever test fails; add coverage if one does not.
- Create: `docs/superpowers/plans/2026-10-04-hub-shred-mutation-log.md` (the evidence)

- [ ] **Step 1: Mutation A — drop `files` from the shred set**

Comment out the `files` entry in `HUB_SHRED_TARGETS`. Run the Task 4 suite.
Expected: the file case FAILS — the content key is still unwrappable.
Record pass/fail, then revert.

- [ ] **Step 2: Mutation B — keep the blob-store mirror**

Restore `files`, but make `deleteBlobEnvelopeMirrors` a no-op. Run the Task 4 suite.
Expected: the blob-mirror case FAILS.
**This is the mutation most likely to slip through.** If it does not fail, the test is asserting the DB column only — fix the test to read the wrap back out of the fake blob store and decrypt with it. Revert.

- [ ] **Step 3: Mutation C — drop `hub_recovery_group_shares`**

Comment out that entry. Add this test to the Task 5 file first if it does not exist:

```ts
it('destroys the recovery shares that could reconstruct the hub key', async () => {
  const hubId = await createHub()
  await seedRecoveryGroup(hubId, { threshold: 3, totalShares: 5 })
  await shred.execute(hubId, 'admin-pk', audit)
  expect(await db.select().from(schema.hubRecoveryGroupShares)
    .where(eq(schema.hubRecoveryGroupShares.hubId, hubId)),
    'a threshold of these reconstructs the hub key — destroying hub_keys without them is not a shred',
  ).toEqual([])
  expect(await db.select().from(schema.hubRecoveryGroups)
    .where(eq(schema.hubRecoveryGroups.hubId, hubId))).toEqual([])
})
```
Expected: FAILS under the mutation, passes when reverted.

- [ ] **Step 4: Mutation D — omit the key-generation bump**

Remove the `hub_key_generation + 1` from the executor. Add a replay test:

```ts
it('cannot be undone by replaying a cached hub-key envelope write', async () => {
  const hubId = await createHub()
  const { generation } = await settings.getHubKeyEnvelopes(hubId)
  const cached = await db.select().from(schema.hubKeys).where(eq(schema.hubKeys.hubId, hubId))
  await shred.execute(hubId, 'admin-pk', audit)
  await expect(settings.setHubKeyEnvelopes(hubId, {
    expectedGeneration: generation,
    envelopes: cached.map(r => ({ pubkey: r.recipientPubkey, enc: r.enc, ct: r.ct })),
  }), 'a replayed envelope write resurrected the shredded key').rejects.toThrow(/generation|shredded/)
  expect(await db.select().from(schema.hubKeys).where(eq(schema.hubKeys.hubId, hubId))).toEqual([])
})
```
Expected: FAILS under the mutation. Revert.

- [ ] **Step 5: Mutation E — the inverse direction**

*Add* `{ kind: 'delete-rows', table: 'puk_envelopes', scope: BY_HUB }` to `HUB_SHRED_TARGETS`.
Expected: the Task 3 deny-list test FAILS *and* the Task 3 column test FAILS (`puk_envelopes` has no `hub_id`). The isolation test is not even reached — the declaration rejects it. That is the structural invariant working. Revert.

- [ ] **Step 6: Write the evidence file and commit**

Record each mutation, the exact command run, and the failing test name and message. A mutation that did not fail gets a note saying what test was added to catch it.

```bash
git add docs/superpowers/plans/2026-10-04-hub-shred-mutation-log.md apps/worker/__tests__/
git commit -m "test(shred): verify the shred set by breaking it, five mutations"
```

---

### Task 7: Request lifecycle — window, cancel, force override, retention floors

**Files:**
- Modify: `apps/worker/services/erasure.ts`
- Modify: `apps/worker/lib/erasure-expiry-worker.ts`
- Test: `apps/worker/__tests__/integration/hub-shred-window.test.ts`

**Interfaces:**
- Produces on `ErasureService`:
  ```ts
  createHubShredRequest(hubId, requestedBy, justification?, emergency?: {
    coApproverPubkey: string; coApproverSignature: string; timestamp: string
  }): Promise<typeof erasureRequests.$inferSelect>
  cancelHubShredRequest(hubId: string): Promise<void>
  getPendingHubShred(hubId: string): Promise<typeof erasureRequests.$inferSelect | null>
  ```

- [ ] **Step 1: Write the failing window test**

The boundary is moved by writing `execute_at` in SQL, so the **database** clock decides. Never `setTimeout`, never a faked `Date`.

```ts
it('restores full readability when cancelled inside the window', async () => {
  const hubId = await createHub()
  const { note, author } = await seedReadableNote(hubId)
  await erasure.createHubShredRequest(hubId, 'admin-pk')
  expect((await getHub(hubId)).status).toBe('shred_pending')

  await erasure.cancelHubShredRequest(hubId)

  expect((await getHub(hubId)).status).toBe('active')
  const [after] = await db.select().from(schema.notes).where(eq(schema.notes.id, note.id))
  expect(() => openEnvelope(author.secret, after.authorEnvelope as never),
    'cancelling must restore readability — nothing was destroyed').not.toThrow()
})

it('is irreversible once the window has elapsed', async () => {
  const hubId = await createHub()
  await erasure.createHubShredRequest(hubId, 'admin-pk')
  // The database clock decides, so move the deadline in SQL.
  await db.execute(sql`UPDATE erasure_requests SET execute_at = NOW() - INTERVAL '1 second'
                        WHERE hub_id = ${hubId} AND status = 'pending'`)
  const expired = await erasure.getExpiredPendingRequests()
  expect(expired.map(r => r.hubId)).toContain(hubId)

  await runExpiryOnce()

  expect((await getHub(hubId)).status).toBe('shredded')
  await expect(erasure.cancelHubShredRequest(hubId)).rejects.toThrow(/404|no pending/i)
})

it('does not expire one second before the deadline', async () => {
  const hubId = await createHub()
  await erasure.createHubShredRequest(hubId, 'admin-pk')
  await db.execute(sql`UPDATE erasure_requests SET execute_at = NOW() + INTERVAL '1 second'
                        WHERE hub_id = ${hubId} AND status = 'pending'`)
  expect((await erasure.getExpiredPendingRequests()).map(r => r.hubId)).not.toContain(hubId)
})
```

- [ ] **Step 2: Write the failing override tests**

```ts
it('executes immediately with a valid co-approver signature', async () => {
  const hubId = await createHub()
  const approver = adminDevice()          // registered admin, != requester
  await erasure.createHubShredRequest(hubId, 'admin-pk', 'closing the hub', {
    coApproverPubkey: approver.pubkey,
    coApproverSignature: approver.sign(`${LABEL_ERASURE_OVERRIDE_SIG}:${hubId}:${ts}`),
    timestamp: ts,
  })
  const [req] = await db.select().from(schema.erasureRequests).where(eq(schema.erasureRequests.hubId, hubId))
  expect(req.emergencyOverride).toBe(true)
  // Force skips the WAIT, not the second pair of eyes (spec §14.1).
  expect(req.executeAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000)
})

it('refuses a force with no co-approval', async () => {
  await expect(erasure.createHubShredRequest(hubId, 'admin-pk', undefined, {
    coApproverPubkey: approver.pubkey, coApproverSignature: '00'.repeat(64), timestamp: ts,
  })).rejects.toThrow(/signature verification failed/)
})

it('refuses a co-approver who is not an admin device', async () => {
  const volunteer = adminDevice({ roles: ['role-volunteer'] })
  await expect(erasure.createHubShredRequest(hubId, 'admin-pk', undefined, {
    coApproverPubkey: volunteer.pubkey,
    coApproverSignature: volunteer.sign(`${LABEL_ERASURE_OVERRIDE_SIG}:${hubId}:${ts}`),
    timestamp: ts,
  })).rejects.toMatchObject({ status: 403, message: /registered admin device/ })
})

it('refuses a co-approver who is the requester', async () => {
  await expect(erasure.createHubShredRequest(hubId, requester.pubkey, undefined, {
    coApproverPubkey: requester.pubkey,
    coApproverSignature: requester.sign(`${LABEL_ERASURE_OVERRIDE_SIG}:${hubId}:${ts}`),
    timestamp: ts,
  })).rejects.toMatchObject({ status: 400, message: /cannot be the same/ })
})

it('refuses a force when the hub disabled emergency override', async () => {
  await erasure.upsertConfig(hubId, { emergencyOverrideEnabled: false }, 'admin-pk', 24)
  await expect(erasure.createHubShredRequest(hubId, 'admin-pk', undefined, {
    coApproverPubkey: approver.pubkey,
    coApproverSignature: approver.sign(`${LABEL_ERASURE_OVERRIDE_SIG}:${hubId}:${ts}`),
    timestamp: ts,
  })).rejects.toMatchObject({ status: 403, message: /disabled for this hub/ })
})

it('still waits the full window when no override is supplied', async () => {
  const hubId2 = await createHub()
  await erasure.createHubShredRequest(hubId2, 'admin-pk')
  const [req] = await db.select().from(schema.erasureRequests)
    .where(eq(schema.erasureRequests.hubId, hubId2))
  expect(req.emergencyOverride).toBe(false)
  const hours = (req.executeAt.getTime() - req.requestedAt.getTime()) / 3600_000
  expect(hours).toBeGreaterThan(47.5)
  expect(hours).toBeLessThan(48.5)
})
```

- [ ] **Step 3: Write the failing retention-floor test**

```ts
it('refuses to shred inside a platform retention floor without an override', async () => {
  await retention.upsertFloors([{ category: 'call_records', minRetentionDays: 90 }], 'platform-admin')
  const hubId = await createHub()
  await seedCallRecord(hubId, { createdAt: daysAgo(10) })
  await erasure.createHubShredRequest(hubId, 'admin-pk')
  await db.execute(sql`UPDATE erasure_requests SET execute_at = NOW() - INTERVAL '1 second'
                        WHERE hub_id = ${hubId}`)

  await runExpiryOnce()

  expect((await getHub(hubId)).status, 'a refused shred must not report success').toBe('shred_pending')
  const [req] = await db.select().from(schema.erasureRequests).where(eq(schema.erasureRequests.hubId, hubId))
  expect(req.status).toBe('failed')
})

it('shreds inside a floor when the request carries a co-approved override', async () => { /* succeeds */ })
```

- [ ] **Step 4: Run all of them and watch them fail**

Run: `bunx vitest run --config vitest.integration.config.ts apps/worker/__tests__/integration/hub-shred-window.test.ts`

- [ ] **Step 5: Implement**

In `ErasureService`:
- Extract the co-approval verification from `createSelfRequest` (lines 178-205) into a private `verifyCoApproval(subjectId, emergency)` and call it from **both** paths. Do not copy it — one implementation, two callers.
- `createHubShredRequest` inserts `scope: 'hub'`, `hubId`, `userId: null`; `executeAt` is `sql\`NOW() + (${hours} || ' hours')::interval\`` using `erasureConfig.hubShredDelayHours`, or `sql\`NOW()\`` when a verified override is present. Sets the hub to `shred_pending` in the same transaction and records the hub's prior status in `previous_status` (added in Task 2), so a cancel restores exactly what was there.
- `cancelHubShredRequest` sets `status='cancelled'`, `cancelledAt=NOW()`, restores the hub's previous status; 404 when no pending hub request exists.
- `getExpiredPendingRequests` changes `lt(erasureRequests.executeAt, new Date())` to `sql\`execute_at < NOW()\`` — **both scopes** now use the database clock.
- In `erasure-expiry-worker.ts`, branch on `request.scope`: `'user'` keeps the existing `executeErasure` path exactly; `'hub'` checks retention floors (unless `emergencyOverride`) and then calls `HubShredService.execute`. A floor refusal calls the existing `markFailed` and leaves the hub `shred_pending`.

- [ ] **Step 6: Run to green, then run the full worker suite**

```bash
bunx vitest run --config vitest.integration.config.ts apps/worker/__tests__/integration/hub-shred-window.test.ts
bun run test:worker
```

- [ ] **Step 7: Commit**

```bash
git add apps/worker/services/erasure.ts apps/worker/lib/erasure-expiry-worker.ts apps/worker/__tests__/integration/hub-shred-window.test.ts
git commit -m "feat(shred): 48h window, co-approved force override and retention-floor refusal"
```

---

### Task 8: Routes, archive enforcement and protocol schemas

**Files:**
- Modify: `packages/protocol/schemas/hubs.ts`, `packages/protocol/schemas/erasure.ts`
- Create: `apps/worker/middleware/hub-writable.ts`
- Modify: `apps/worker/routes/hubs.ts`, `apps/worker/services/settings.ts`, `apps/worker/services/index.ts`
- Test: `apps/worker/__tests__/unit/routes/hub-shred-routes.test.ts`, `packages/test-specs/features/security/hub-shred.feature`

- [ ] **Step 1: Extend the protocol schemas**

In `packages/protocol/schemas/hubs.ts:12`, the status enum becomes
`z.enum(['active', 'suspended', 'archived', 'shred_pending', 'shredded'])`.
Add `hubShredRequestBodySchema` (optional `justification`, optional `emergency` object of `coApproverPubkey`/`coApproverSignature`/`timestamp`) and `hubShredStatusResponseSchema`.

Run `bun run codegen`. Confirm Swift and Kotlin regenerate without error.

- [ ] **Step 2: Write the failing route tests**

Assert: `POST /hubs/:id/shred` requires `system:manage-hubs` (401/403 without it); a second request while one is pending is 409; `DELETE /hubs/:id/shred` cancels; `DELETE /hubs/:id` now schedules a shred rather than purging; a write to an `archived` hub is 409 while a read is 200.

- [ ] **Step 3: Implement the middleware**

`apps/worker/middleware/hub-writable.ts` — reads the hub's status and returns 409 for `archived`, `shred_pending` or `shredded`. Mount it on hub-scoped mutating routes beside `requirePermission`. Reads are untouched: an archived hub stays fully readable because `hub_keys` is intact.

- [ ] **Step 4: Implement the routes and the settings guard**

- `POST /:hubId/shred` → `erasure.createHubShredRequest`, audit `hubShredScheduled`.
- `DELETE /:hubId/shred` → `erasure.cancelHubShredRequest`, audit `hubShredCancelled`.
- `DELETE /:hubId` → the same scheduling path, **not** `purgeHub`. Keep `purgeHub` for demo reset (#1133); add a comment saying so and naming #1502 as still open for that path.
- In `SettingsService`, `setHubKeyEnvelopes` and `rotateHubKey` throw `ServiceError(409, ...)` for a hub whose status is `shredded`.
- Register `HubShredService` in `apps/worker/services/index.ts` with the blob storage binding.

- [ ] **Step 5: Write the BDD feature**

`packages/test-specs/features/security/hub-shred.feature`, tagged `@backend`, covering: schedule → pending → cancel → readable; schedule → window elapses → shredded → unreadable; force with co-approval; force without co-approval refused. Step definitions in `tests/steps/backend/hub-shred.steps.ts`.

- [ ] **Step 6: Run everything**

```bash
bun run codegen && bun run typecheck
bun run test:worker
bun run test:backend:bdd
```

- [ ] **Step 7: Commit**

```bash
git add packages/protocol/schemas/ apps/worker/ packages/test-specs/ tests/steps/
git commit -m "feat(hubs): shred and cancel routes, archive write-guard, shredded-hub key-write refusal"
```

---

### Task 9: Strings and desktop UI

**Files:**
- Modify: `packages/i18n/locales/*.json` (every locale in `packages/i18n/languages.ts`)
- Modify: `src/client/routes/admin/hubs.tsx`, `src/client/lib/api/hubs.ts`

- [ ] **Step 1: Add the keys to `packages/i18n/locales/en.json`**

Beside the existing `hubs.deleteHub*` family: `hubs.shredHub`, `hubs.shredHubDescription`, `hubs.shredHubWarning` (naming the 48-hour window), `hubs.shredPendingBanner` (with a `{deadline}` placeholder), `hubs.cancelShred`, `hubs.shredForceLabel`, `hubs.shredForceCoApproval`, `hubs.shredRetentionFloorRefused`, `hubs.archiveHub`, `hubs.unarchiveHub`, `hubs.status.shred_pending`, `hubs.status.shredded`.

- [ ] **Step 2: Propagate to every locale and generate**

```bash
bun run i18n:codegen
bun run i18n:validate:all
```
Expected: no missing-key errors. Never add a string to a platform file directly.

- [ ] **Step 3: Wire the desktop UI**

Reuse the existing type-to-confirm dialog at `src/client/routes/admin/hubs.tsx:336-366`; change its copy to the shred strings, add the window to the confirmation, add the pending banner with its deadline and a cancel button, and add archive/unarchive.

- [ ] **Step 4: Run the desktop suite**

```bash
bun run test:desktop
```

- [ ] **Step 5: Commit**

```bash
git add packages/i18n/ src/client/
git commit -m "feat(desktop): hub shred confirmation, pending banner and archive controls"
```

---

### Task 10: File the gaps the spec records

The spec states two limits rather than guessing at them. A stated limit with no
issue behind it is a limit nobody will ever act on.

**Files:** none — this task produces two GitHub issues and two spec cross-references.

- [ ] **Step 1: File the nullable-`hub_id` gap**

`notes`, `call_records`, `case_records`, `events`, `subscribers`, `blasts`,
`active_calls` and `shifts` all permit a NULL `hub_id`. Such a row carries live
envelopes but is attributable to no hub, so no hub-scoped sweep can reach it and a
shred leaves it readable. Title it as the defect it is — "envelope-bearing rows with a
NULL hub_id are unreachable by hub shred and by hub purge" — and name the eight
tables. Include the reproduction: insert a note with `hub_id = NULL`, shred, confirm
the envelope survives.

- [ ] **Step 2: File the `encrypted_*`-columns-that-are-not gap**

`ring_groups.encrypted_name`, `shifts.encrypted_name`, `shift_overrides.encrypted_note`
and `user_availability_blocks.encrypted_reason` are written as plaintext —
`src/client/routes/shifts.tsx:358` passes the raw input straight through and no
`encryptHubField` call exists for any of them. Shift and ring-group names are
organisational structure, which the project's encryption scope covers. Note that
`origin/fix-1042`'s `assertCoversExactly` covers only `tags` and `teams`, which is
correct **only** while these stay plaintext and becomes a rotation data-loss bug the
day they are encrypted without being added there.

- [ ] **Step 3: Cross-reference both from the spec**

Add the two issue numbers to spec §4 ("Rows with a NULL hub_id are not shredded" and
the Class A note on misnamed columns), so a later reader finds the tracking issue from
the limit.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-10-03-hub-deletion-crypto-shred-design.md
git commit -m "docs(spec): link the two tracked limits of the hub shred set"
```

---

## Final verification before opening the PR

```bash
bun run typecheck
bun run test:worker
bun run test:worker:integration
bun run test:backend:bdd
bun run test:desktop
bun run i18n:validate:all
```

**Cite the local runs as the evidence, not a green check.** `fleet/verify` has been judging PRs against the base's workspace packages (#1525, fix in #1526), so a bare `@llamenos/*` import can make the gate green for the wrong reason. The claims in spec §7 are backed by these runs against real PostgreSQL on this worktree's isolated database.

The PR body must carry `Closes #<hub-deletion issue>` and must **not** claim to close #1502 (still open for demo reset, §9 of the spec) or #1133.
