## Determinism Rules (fold into every worker prompt — single source, no per-lane copies)

Each learned from a live fleet failure. Full list + failures:
`docs/superpowers/specs/2026-09-11-llamenos-fleet-orchestrator-design.md#determinism-invariants`.

- **Never merge.** One PR, `Closes #<issue>` on its own line, then stop — the fleet arms
  auto-merge. Never `--admin`, `--force`, `--approve`, `--request-changes`, `--no-verify`,
  or a ruleset edit.
- **A red check is fixed or reported, never re-run to "get green."**
- **Derive status, never self-report it.** Branch/worktree/PR/outcome come from `git`/`gh`
  at read time — never carried in a status file.
- **Pass the branch explicitly and verify the worktree is on it** before starting; a
  mismatch is a recorded failure, never a silent skip.
- **Run every command in the FOREGROUND** — no `&`, `run_in_background`, `nohup`, or a
  Monitor/wait loop; a backgrounded run outlives the session with no terminal status.
- **Codegen renames are bulk renames** — never a typealias, never a hand-written duplicate.
- **No non-waiting probe may guard a write** — `isVisible()`/`.first()` around a
  click/fill/toggle is a bug regardless of flakiness.
- **Fix the app, not the test** — a test passing when its dependency is unreachable is a
  no-op; make it fail loudly or exclude it by tag.
- **Testid-only selectors** in any E2E test — no CSS class or text selectors.
- **Request a review to get one.** Assigning `llamenos-auto` as reviewer — or re-requesting
  review from them — is what runs `fleet/review`. No label triggers it. The agent decides
  which reviews to run from the PR's `-reviewer` labels and from the PR itself; they run
  together and report one check. Add a `-reviewer` label only to ask for a review the PR's
  own content would not already imply.
- **Crypto changes get `crypto-security-reviewer` automatically** — any diff touching
  HPKE/Ed25519/X25519/sigchain, Tauri IPC crypto bridges, or UniFFI/JNI crypto bindings,
  by path or by your PR description. Say so in the description if the paths do not show it.

## Migrations (#2391 — read before adding one)

- **Generate, never number by hand.** Change `apps/worker/db/schema/`, then
  `bun run db:generate --name <what>` (`--custom` for hand-written SQL). It writes
  `drizzle/migrations/YYYYMMDDHHMMSS_<what>.sql` and `meta/<same>_snapshot.json`, whose
  `prevIds` name the heads it was generated on. `bunx drizzle-kit generate` is retired: it
  needs the deleted `_journal.json` and aborts once two snapshots share a parent.
- **Another migration landing first changes nothing for you.** Do not rename, renumber or
  regenerate because main moved. Yours becomes a second head: `migration:check` merges the
  heads, `migration:safety` lets a concurrent file sort before one main already has, and
  `migration:order` proves in Postgres that both apply orders build one schema. Regenerate
  only when a gate reports a CONFLICT (both changed the same object differently).
- **Before pushing:** `bun run migration:check`, `bun run migration:safety --ci`,
  `bun run migration:claims --against-open-prs` (pre-push runs the first and last). Every
  failure prints its exact fix.
- **The `prevId` trap (numbered PRs from before the cutover: #2307, #2361, #2382, #2399).**
  A snapshot is a full copy of the schema, not a diff. Renumbering a numbered file, or
  hand-editing its `prevId` to main's newest snapshot, leaves a snapshot that still lacks
  every column main — or an earlier pending PR — added since. It passes locally and fails
  `migration-drift` in the merge group, taking the whole batch down. The fix is always to
  regenerate:
  `git show HEAD:<file>.sql > /tmp/<file>.sql` (keep hand edits) →
  `git fetch -q origin && git rebase origin/main` → `git rm -q` the `.sql` and its snapshot →
  `bun run db:generate --name <what>` → re-apply the hand edits → rerun the three checks.
- **Never generate on another PR's unmerged schema.** A "forward" snapshot that already holds
  an open PR's columns is rejected by the pre-push `migration:check`, and rightly: this
  branch's schema does not declare those columns, so the snapshot describes a schema the
  branch cannot build, and it is wrong on main if that PR changes or never lands. Push the
  snapshot generated on main with only this branch's change, say so in the PR body
  ("migration generated without #N"), and after #N lands rerun the checks — a timestamped
  migration normally needs nothing; regenerate only if one reports a conflict.
