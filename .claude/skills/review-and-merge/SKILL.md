---
name: review-and-merge
description: Use when a PR is ready for its non-author review and merge — the operator runs `llamenos-fleet review-and-merge <pr>` instead of a manual `gh pr review` + `gh pr merge` sequence. Use when the user says "review and merge this PR", "run review-and-merge on #N", or asks to merge a PR that still needs a non-author review.
---

# review-and-merge

`orchestrator/src/review-and-merge.ts`, invoked as `llamenos-fleet review-and-merge <pr>`,
is now **the merge path** — the one command that turns a green PR into a merged one. It
replaces a human typing `gh pr review` then `gh pr merge` by hand, and it replaces the
`fleet/review` GitHub Actions job as the primary way that check-run gets produced (the
Actions workflow stays as the fallback reviewer — see its own file header — so the repo is
never left with a window with no reviewer at all).

Because this command performs the merge, it is bound by the same five gating invariants
that govern every merge in this fleet — canonical source
`docs/superpowers/specs/2026-09-11-llamenos-fleet-orchestrator-design.md#determinism-invariants`,
items 1–5. This skill exists to keep those five explicit at the one place a human or an
agent triggers a real merge, rather than trusting them to be remembered:

1. **A skipped required check counts as SATISFIED.** `review-and-merge` never trusts a
   "skipped" `fleet/review` context as a pass — it reads `gh pr checks --required` and
   requires `bucket == 'pass'` on every entry, `fleet/review` included
   (`evaluateMergeReadiness`). A skipped or missing check is a refusal, not a merge.
2. **Freshness is keyed to the head SHA, never a time window.** The review it posts (or
   reuses) is checked against the PR's *current* head at merge time
   (`currentHeadSha` vs. `reviewedHeadSha`); if the head moved since the review ran, it
   refuses with "refusing to merge a commit that was never reviewed" rather than merging a
   stale approval.
3. **Anything this command calls must already exist on `main`.** It runs from the
   operator's own checkout against a PR that has already passed `fleet/verify` on base-ref
   code — it never re-derives or re-runs the mechanical scope/test gates itself
   (`reportForPrompt`'s comment explains why: that would be a second, driftable copy of a
   decision GitHub's required checks already make).
4. **A red check is fixed or reported — never re-run to "get green."** If the non-author
   review verdict is `FAIL` or `UNREADABLE`, the command returns `not-mergeable` with the
   verdict named and stops. It does not retry the engine and does not merge around it.
5. **Never `--admin`, `--force`, `--approve`, or `--no-verify`.** `runReviewAndMerge`'s one
   merge call is a plain `gh pr merge <pr> --squash --delete-branch` — no bypass flag
   exists in this file. A bot-authored PR additionally requires a human code-owner's
   approval before this command will merge it (`needs-codeowner`); it never approves on the
   operator's behalf.

And one that is specific to this command rather than to merging in general:

6. **A verdict is recorded as a GitHub App, or not at all (#1483).** The `fleet/review`
   check-run is posted with a short-lived App installation token minted per invocation
   (`orchestrator/src/github-app.ts`), because the Checks API refuses a PAT. Nothing else in
   the command uses that token, nothing persists it, and no failure path prints the key, the
   JWT or the token. Without working credentials the command refuses *before* reviewing
   rather than reviewing and then losing the answer.

## Running it

```bash
llamenos-fleet review-and-merge <pr-number>
```

- Exit **0** only for `merged` or `already-merged`.
- Exit **1** for `cannot-record` — the `llamenos-fleet-review` GitHub App credentials
  (`FLEET_REVIEW_APP_ID` + `~/.llamenos-fleet/review-app.pem`, mode 600) are absent or
  unusable, so the command refused **before** spending a review and posted nothing. The
  Checks API refuses a PAT, and there is no fallback by design (#1483) — a PAT-written
  commit status could override a red check run, which is fail-open. Use the CI gate until
  the App exists; see `orchestrator/README.md` ("Recording a verdict").
- Exit **1** for `review-unrecorded` — the review RAN and its verdict could not be written
  to GitHub. The verdict is LOST, nothing was posted, nothing was merged. The command says
  so plainly rather than reporting a success it did not achieve.
- Exit **1** for `not-mergeable` (with the reason — unreviewed head, red check, missing
  `fleet/review`, or a real `FAIL`/`UNREADABLE` verdict) or `needs-codeowner` (bot-authored
  PR awaiting human approval) — both are refusals, not errors to retry past.
- Idempotent on an unchanged head: a PR whose head already carries a successful
  `fleet/review` check-run skips straight to the readiness check, so running it twice costs
  one extra `gh` read, never a second review or a second merge attempt.

## What it does NOT do

- It does not run mechanical verification (`fleet/verify`) — that must already be green.
- It does not touch `orchestrator/` merge policy itself; `orchestrator/` changes are
  always-human per the merge policy (§5.8 of the design spec) regardless of what this
  command reports.
- It never merges the release PR (`chore: prepare release v...` on branch `release`) — that
  is a human-only action per the Llámenos worker rules, unconditionally.
