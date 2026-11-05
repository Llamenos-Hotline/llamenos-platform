# Named owner scope: platform rows without an absent hub (#2463)

Status: **design accepted (operator ruling, 2026-11-05). `bans` is converted in code. The SQL constraint is NOT enforced yet. It is blocked on an operator decision (see [Enforcement status](#enforcement-status)).**

Related: #2459 (M1 invariant: no hubless data; survey in `docs/audits/2026-11-04-hubless-data-survey.md`, #2466), #2464 (per-column companion map, which executes this plan), #2383 (applying a template changes every hub), #2460 / #2461 (the hub-`''` producers).

## The problem

Every permission decision in this app is scoped by hub membership. Several M1 row sets also hold **platform** rows, which belong to the deployment rather than to any hub: the platform ban list, the platform audit chain, platform incidents, the global provider, and the platform default templates. Before #2463, every one of them said "platform" by **leaving the hub out**. They wrote `hub_id IS NULL` or `hub_id = ''`.

That makes the platform an accident of omission. A producer that forgets its hub does not fail. It writes a platform row. A router mounted without a hub does not refuse. It serves the platform list. Concrete instances, all removed for `bans` in this change:

- `/api/bans` was mounted both unscoped and under `/hubs/:hubId`. With no hub, it served the **platform** ban list, gated by the **hub** permissions (`bans:create`, `bans:delete`), not by `bans:*-platform`. The permission matrix asserted that a hub-admin gets `200` there.
- An in-call ban on a call with no hub (#2460's hub-`''` bucket) hashed and stored the caller under the **platform** key. A `bans:report` holder could therefore ban a caller deployment-wide.
- The BDD "duplicate ban" scenario posted its second ban to the unscoped mount. It landed on the platform list, so the hub list never saw a duplicate and the dedupe assertion was vacuous. The permission-matrix delete scenario deleted a hub ban through the unscoped mount. That deleted nothing, and still answered `200`.

## Correcting a premise: platform rows really have no hub

Not everything platform-level "ultimately carries a hub id". A platform ban concerns a caller, not any hub's records. A platform audit entry for setup, hub creation or a super-admin role change happens before or outside every hub. **These rows must not be given an invented hub id.**

What makes an absent hub safe is that **absence is legal only when a scope column says so**:

- A bare nullable `hub_id` with no scope column is the bug #2459 names. Nothing distinguishes "platform" from "the producer forgot".
- A nullable `hub_id` **guarded by a scope CHECK** is not that bug. No row can be written unowned by omission. A producer that forgets the hub violates a constraint instead of creating a bucket.

**Do not "simplify" the scope column away** because it looks derivable from `hub_id IS NULL`. Deriving the scope from absence is exactly the defect. The column turns an omission into a constraint violation.

## The model

One discriminated union, used by every scoped row set:

| `scope` | `hub_id` | `organization_id` (M2) | Meaning |
|---|---|---|---|
| `hub` | NOT NULL, FK `hubs(id)` | NULL | Owned by one hub. Hub admins govern it. |
| `platform` | NULL | NULL | Owned by the deployment. Super-admin / `*-platform` permissions govern it. |
| `organization` (M2) | NULL | NOT NULL, FK `organizations(id)` | Owned by one organization. |

### TypeScript (`packages/shared/owner-scope.ts`)

```ts
type OwnerScope =
  | { kind: 'hub'; hubId: string }
  | { kind: 'platform' }
  // M2: | { kind: 'organization'; organizationId: string }
```

- `hubScope(id)` refuses an empty id, so the hub-`''` bucket cannot be expressed as a scope.
- `PLATFORM_SCOPE` is the only scope with no owner id.
- Every `switch (scope.kind)` ends in `assertNeverScope(scope)`. When M2 adds the organization member, the compiler names every site that must handle it. There is no silent fallthrough to "platform".
- The organization member is **not** in the M1 union. With no producer, adding it would only add unreachable branches. M2 adds it in the same change as its first producer.

### SQL (target shape, verified on PostgreSQL 17)

```sql
-- Created ONCE, shared by every scoped table. All three values from day one,
-- so M2 never runs ALTER TYPE ... ADD VALUE over these tables.
CREATE TYPE owner_scope AS ENUM ('hub', 'platform', 'organization');

ALTER TABLE <t> ADD COLUMN scope owner_scope NOT NULL;   -- no DEFAULT: an INSERT must state it
ALTER TABLE <t> ADD CONSTRAINT <t>_owner_scope CHECK (
     (scope = 'hub'      AND hub_id IS NOT NULL)
  OR (scope = 'platform' AND hub_id IS NULL)
);
-- 'organization' is a legal enum value that the M1 CHECK refuses: no M1 row can claim it.

-- Uniqueness is per scope, keyed on the scope column, not on NULL-ness of hub_id:
CREATE UNIQUE INDEX <t>_hub_<key>      ON <t> (hub_id, <key>) WHERE scope = 'hub';
CREATE UNIQUE INDEX <t>_platform_<key> ON <t> (<key>)         WHERE scope = 'platform';
```

There is deliberately **no `DEFAULT` on `scope`**. A default of `'hub'` would let a producer that forgets the scope fall into the CHECK by luck. A default of `'platform'` would recreate the bug. Without a default, a missing scope is a `NOT NULL` violation.

Checked in a scratch database (PG 17.8): a `hub` row with a NULL hub, a `platform` row naming a hub, an INSERT that omits `scope`, and an `organization` row before M2 are all refused. A second platform ban for the same hash hits the partial unique index, and `ON CONFLICT (phone_hash) WHERE scope = 'platform' DO NOTHING` dedupes against it.

### Why not something else

- **Boolean `is_platform`.** It is two-valued forever. M2 would need a second encoding for organizations.
- **Two-valued enum or CHECK list (`hub`, `platform`).** M2 would widen the vocabulary with a second migration over the same tables. The enum carries all three values from the start.
- **A sentinel hub id (`hub_id = 'platform'` or `''`).** It invents an owner that does not exist, defeats the FK to `hubs`, and is the `''` bucket #2460 / #2461 are removing.
- **A separate table per scope.** This is legitimate when a row set has **no hub variant at all**. `retention_platform_floors` already does it, correctly. For a row set with both hub and platform rows of the same shape (bans, the audit chain), one table plus a scope column keeps one implementation of every query.

## How organizations slot in (M2)

M2 runs one migration per scoped table, and it has the same shape every time:

```sql
ALTER TABLE <t> ADD COLUMN organization_id text REFERENCES organizations(id);
ALTER TABLE <t> DROP CONSTRAINT <t>_owner_scope;
ALTER TABLE <t> ADD CONSTRAINT <t>_owner_scope CHECK (
     (scope = 'hub'          AND hub_id IS NOT NULL AND organization_id IS NULL)
  OR (scope = 'platform'     AND hub_id IS NULL     AND organization_id IS NULL)
  OR (scope = 'organization' AND hub_id IS NULL     AND organization_id IS NOT NULL)
);
CREATE UNIQUE INDEX <t>_org_<key> ON <t> (organization_id, <key>) WHERE scope = 'organization';
```

That is **one value enabled and one column added**. It is not a second encoding, and it is not a widened type. The `organization_id` column cannot exist in M1, because there is no `organizations` table for it to reference. An always-NULL, FK-less column would be dead weight that nothing enforces. (Verified: the swap above, run in a transaction, accepts an organization row with an id and refuses one without.)

In TypeScript, M2 adds the union member. `assertNeverScope` then fails to compile at every unhandled `switch`, and the storage helpers in `apps/worker/lib/owner-scope.ts` gain their organization branch.

Ban hashes need one decision in M2. A scope's ban key is HKDF info `llamenos:ban-key-derive:v1:<suffix>` (`LABEL_BAN_KEY_DERIVE`). The suffix is the hub id for a hub (a `crypto.randomUUID()`) and the literal `platform` for the platform. An organization must use a suffix no hub id can equal, such as `org:<id>` (`apps/worker/lib/crypto.ts` `banKeyScope`).

## Conventions for a converted row set

The `bans` conversion is the pattern. Copy it.

1. **The service takes `scope: OwnerScope`** on every method over the row set. It never takes `hubId?: string`. A lookup that spans scopes (a call is checked against its hub's list **and** the platform's) takes a list of `{ scope, … }` pairs, each matched only inside its own scope (`ScopedBanHash`, `banLookupWhere`).
2. **Only `apps/worker/lib/owner-scope.ts` reads or writes the storage encoding.** `scopeWhere(column, scope)` builds the predicate, `scopeColumns(scope)` gives the INSERT values, and `scopeOfRow(row)` decodes a stored row. Until the scope column exists they read `hub_id`. When it lands they read `scope`, and no caller changes.
3. **Routes state the scope. They never infer it.**
   - A hub router is mounted **only** under `/api/hubs/:hubId`, registers `hubOnly`, and builds `hubScope(pathHubId(c))`.
   - A platform router lives under **`/api/admin/*`** (`/admin/audit`, `/admin/incidents`, `/admin/bans`), with its own `*-platform` / `system:*` permissions, and passes `PLATFORM_SCOPE`.
   - No router serves both by whether a hub is present. `__tests__/unit/app-mounts.test.ts` enforces this. A hub-owned mount may have **no** unscoped route under its prefix, which is why the platform ban list moved from `/api/bans/platform` to `/api/admin/bans`.
4. **A stored row's scope is decoded with `scopeOfRow`**, never with `if (row.hubId)`. For example, `promote` refuses a ban whose scope is `platform`.
5. **Audit entries for a hub row carry the hub.** The old `hubId ?? null` could send a hub action into the platform chain.
6. **Branch on permissions, never on role names.** Scope says who owns a row. Permissions say who may act on it. Neither stands in for the other.
7. **Clients address a hub resource through the strict helper** (`activeHubPath` on desktop, iOS and Android), which throws when no hub is active. The `hp()` fallback to the bare path is the client-side producer of "absent means platform".

## Enforcement status

**Not enforced in SQL yet.** The invariant is currently held only by the TypeScript layer described above. The CHECK is landed by #2476, through the `constrain` annotation described below.

### Why the gate refused it

Before #2471, the migration-safety gate refused the constraint. A probe migration (`CREATE TYPE owner_scope …`, `ADD COLUMN scope … DEFAULT 'hub' NOT NULL`, an `UPDATE … SET scope = 'platform' WHERE hub_id IS NULL`, `DROP DEFAULT`, `ADD CONSTRAINT … CHECK`) was run through `bun run migration:safety --ci` and then deleted:

```
✗ statement 4: add-constraint-existing column public.bans.hub_id [CONSTR_CHECK]:
  the previous release writes rows the new constraint rejects.
[migration-safety] FAILED: 1 violation(s)
```

The refusal is **correct on its own terms**, and the reasoning is why an absent id is unsafe to leave unconstrained. An N-1 release writes platform bans without naming `scope`, and the new constraint rejects those rows. At the time the gate had no way to admit a tightening of a column the replaced release still declares: its only annotation, `allow`, is verified against a snapshot that no longer declares the object, and `bans.hub_id` is still declared. #2467 hit the same refusal for `NOT NULL` / FK on `active_calls.hub_id` and `call_records.hub_id`.

### The remedy chosen: a reviewed `constrain` annotation (#2468, #2471)

The first draft of this document weighed three remedies. It recommended a baseline regeneration (R1) and rejected an annotation for constraints (R3) on the grounds that an unverifiable "trust me" annotation would weaken the gate permanently. That was written without knowledge of #2468 / #2471 and is superseded on both counts:

- **The operator ruled for the annotation path on 2026-11-05 (#2468).** A baseline regeneration only works while the project is pre-production. An annotation behaves the same way once there is production data.
- **What #2471 shipped is not an unverifiable annotation.** `-- migration-safety: constrain column <schema>.<table>.<column> because <reason>` covers only tightenings (`set-not-null`, `add-constraint-existing` for UNIQUE / PK / FK / CHECK, `unique-index-existing`), never a drop, rename or retype. It licenses only the statement that carries it, and an annotation that matches no finding in its statement is itself a violation. The reason must be at least five words and is printed as a CI notice. The newest snapshot must still declare the object, and a `SET NOT NULL` must be declared `.notNull()` in drizzle. The schema contract accepts "became NOT NULL" only for a column a `constrain` annotation admitted. Unannotated statements are refused with the unchanged message. Six injected mutations of the gate were each caught by its tests, and a real-Postgres `--target` test covers it (`docs/runbooks/migrations.md`, "Tightening: `constrain`").

The annotation does not make the N-1 problem disappear. It moves it to where a person must answer it in the diff: the reason has to say why the previous release can no longer write a row the constraint rejects. For `bans` that means the `scope` column ships first, with every producer writing it, and the CHECK follows once the release being replaced is one that writes `scope`. The other two remedies the first draft listed, a baseline regeneration (R1) and per-table replacement (R2), are not pursued.

Until the CHECK lands, every converted row set still stores its scope as "hub id present or absent". The guarantee is that **no code path writes or reads that encoding except `lib/owner-scope.ts`**, and every caller states its scope.

## Application plan, by row set

This is what #2464 executes. "(a)" means "keep as deployment configuration, with a named scope". "(b)" means "it is hub data; remove the platform copy". The DDL in each row lands through the `constrain` annotation ([Enforcement status](#enforcement-status)): the `scope` column first, the CHECK once the release being replaced writes it. The code half of each row can land now, following the `bans` pattern.

| Row set | Today | Ruling | Target | Notes / blocked on |
|---|---|---|---|---|
| **Ban list** (`bans`) | `hub_id IS NULL` = platform. Partial unique index on `hub_id IS NULL`. | (a) | `scope` + CHECK. Partial unique indexes keyed on `scope`. | **Converted in code (#2470).** DDL: #2476. |
| **Audit chain** (`audit_log`) | `hub_id IS NULL` = the platform chain | (a) | `scope` + CHECK. The hash chain is per scope. `audit(…)` takes a scope instead of `hubId ?? null`. | First fix the producers that write hub actions into the platform chain: #2460 (calls) and #2461 (unscoped record mounts). `/api/admin/audit` already exists. |
| **Incidents** (`hub_incidents`, `PlatformIncidentRow`) | `hub_id IS NULL` = platform | (a) if a producer survives | `scope` + CHECK, or remove the platform half | The only known producer is an erasure of a subject in no hub (#2347). If #2194 / #2459 make hubless users impossible, the platform scope has no producer and is removed. Decide after #2194. The `20261031214240` snapshot still records `hub_id` NOT NULL (#2464). Fix it in the same migration. |
| **Global provider** (`provider_configs.hub_id IS NULL`, `oauth_states.hub_id`) | NULL = the global provider. Hubs fall back to it. | (a) | `scope` + CHECK. Provider resolution becomes an explicit two-scope lookup (hub, then platform), shaped like `callBanLookup`. | The messaging sender is deployment-wide (#2395). The **voice number** is what maps a call to a hub (#2460, #1331), so a platform voice provider must not route calls into a hub by fallback. Settle that with #1331. |
| **IVR audio, entity / relationship / report types** (`hub_id = ''` = platform default) | NOT NULL `DEFAULT ''`. Hub reads fall back to the `''` row. Protocol `hubId: z.string().optional().default('')`. | **Split template from type** | (1) `*_templates` tables are the platform templates: configuration with a `scope` column (`platform` now, `organization` in M2). (2) The type tables become hub data: `hub_id` NOT NULL with an FK and no `DEFAULT ''`, and **no** platform row. Hub creation copies the templates into the hub's own rows. A hub edits its copy, never the shared row. | **Fixes #2383 at the root.** Protocol `hubId` becomes required, and codegen drops the client optionals. Hub records reference only their hub's type ids. |
| **Custom note fields** (`custom_field_definitions`, no hub column) | One deployment-wide list, replaced wholesale | Split template from type (same as above) | Per-hub definitions (hub data, since notes reference them), plus optional platform templates | Note fields are referenced by hub notes, so they are hub data. Also replace `getCustomFields(role = 'admin')` with a permission check. |
| **Instance fallback ring group** (`system_settings.fallbackGroup`) | Read only by a hub-`''` call | **(b)** | Removed | Removed by #2467 (`forget_instance_fallback_group`), together with the hubless call path. |
| **Retention floors** (`retention_platform_floors`) | A named platform table, no hub column | (a) | No change. A dedicated platform table is a valid encoding. | Already correct. |
| **Messaging suppressions** (`messaging_suppressions.source_hub_id`) | Nullable provenance on a deployment-wide STOP list | (a) | No scope column: **every** row is platform-owned, so the table itself is the named scope. `source_hub_id` is provenance, not ownership. Document it as such, with an FK and nullable. | The sender is deployment-wide (#2395). |

`erasure_requests` is the precedent for the CHECK shape. Its discriminator, `scope IN ('user', 'hub')`, names the erasure **subject**, not the row's owner. It keeps its own column and is not migrated to `owner_scope`.

## Sites that relied on absence, and now state their scope (`bans`)

| Site | Before | After |
|---|---|---|
| `services/records.ts` `addBan` | `input.hubId \|\| null`. The conflict target and the existing-row lookup branch on `hubId ? … : hub_id IS NULL`. | `input.scope` → `scopeColumns`, `banConflictTarget(scope)`, `scopeWhere` |
| `listBans` | `hubId ? eq(…) : isNull(…)` | `listBans(scope)` |
| `bulkAddBans` | `hubId \|\| null`, an untargeted `onConflictDoNothing()` | `bulkAddBans(scope, …)`, targeted at the scope's index |
| `removeBan` | `if (hubId) … else IS NULL` | `removeBan(scope, phoneHash)` |
| `checkBan` | `hubId && hashes.hub ? … : platform` | `checkBan(lookups: ScopedBanHash[])` |
| `searchBans`, `listPlatformBans`, `deletePlatformBan` | `hubId ? eq : isNull` / bare `isNull` | `banLookupWhere` / `scopeWhere(…, PLATFORM_SCOPE)` |
| `lib/crypto.ts` `banHash` / `banHashes` | Scope string `hubId \|\| 'platform'`, optional `hub?` hash | `banHash(phone, scope)`. Derivation byte-identical, pinned by `crypto.test.ts`. `banLookup`, `callBanLookup`. |
| `routes/bans.ts` | `scopeOf(hubId) = hubId \|\| PLATFORM`, `audit(…, hubId ?? null)` ×3 | `hubOnly`. `hubScope(pathHubId(c))`. Audit always carries the hub. |
| `app.ts` | `authenticated.route('/bans', …)`: the platform list behind hub permissions | Removed. The platform list is `/api/admin/bans`. |
| `routes/calls.ts` in-call ban | `banHubId \|\| PLATFORM_BAN_SCOPE` | The call's hub. A hubless call is not banned. |
| `routes/platform-bans.ts` promote | `!sourceBan.hubId` ⇒ "already platform" | `scopeOfRow(sourceBan).kind === 'platform'` |
| `telephony.ts`, `dev.ts`, `call-simulation.ts` | `checkBan(banHashes(n, hubId), hubId)` | `checkBan(callBanLookup(n, hubId))` |
| Desktop `lib/api/bans.ts`, iOS `AdminViewModel`, Android `AdminViewModel` | `hp()` / a bare `/api/bans`, which fell back to the platform list with no active hub | `activeHubPath(…)`: throws with no hub |

**No inference remains.** `callBanLookup(phone, hubId: string)` always checks a call against its hub's list and the platform's. Its hubless branch, which checked a call with no hub against the platform list alone, was deleted once #2467 made telephony refuse a call to a number no hub owns (#2460).

## Hub-admin invariant

Bans are not notes, so note visibility is unchanged. The change tightens governance in two places. A hub's bans and their audit entries now always name the hub, so that hub's admins see them. The platform list is reachable only with the `bans:*-platform` permissions, which the default hub-admin role does not carry (`packages/shared/permissions.ts`).
