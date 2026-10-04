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
