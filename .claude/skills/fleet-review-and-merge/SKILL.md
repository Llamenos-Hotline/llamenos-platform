---
name: fleet-review-and-merge
description: Use when the user asks to review and merge a fleet (or any) pull request from the terminal, mentions "review-and-merge", "llamenos-fleet review-and-merge", or wants a non-author coding-agent review recorded as the `fleet/review` check and then merged. Covers what the command does, its freshness/idempotency behavior, and why it refuses to merge in each failure mode.
---

# `llamenos-fleet review-and-merge <pr>`

A local operator command that reviews a pull request as a coding-agent session, records
the verdict as the real `fleet/review` GitHub check-run, and merges the PR — but only once
GitHub itself reports every required check green on an unmoved head.

Implementation: `orchestrator/src/review-and-merge.ts` (orchestration + all deps), wired
into `orchestrator/src/cli.ts`'s `HANDLERS` table. Tests:
`tests/orchestrator/review-and-merge.test.ts`, plus the two rails in
`tests/orchestrator/guards.test.ts` ("only file that creates a check-run" and the extended
"gh pr merge" shape rail).

## Why this exists instead of only the `fleet-review.yml` Actions workflow

A coding-agent session reviews far better than a metered API call boxed into a CI job's
turn/timeout budget, and every attempt to run the review engine *inside* CI has cost this
repo a steady stream of pure-plumbing PRs (bootstrap ordering, base-ref CLI availability,
skipped-vs-absent semantics, label association, engine smoke tests, provider quota). This
command moves the review to the operator's own terminal — but GitHub stays the enforcer:
the verdict is posted as a real check-run via the Checks API, attached to the PR's head SHA,
exactly as authoritative as the Actions job's own result. A stray `gh pr merge` from
anywhere else, or a bug in this command's own merge step, cannot skip that gate.

`.github/workflows/fleet-review.yml` is NOT deleted by adding this command — see that
file's own header for why a repo must never have a window with no reviewer at all. It is a
planned follow-up, once this command is proven on real PRs.

## What it does, in order

1. **Freshness check.** Looks up any existing `fleet/review` check-run on the PR's
   *current* head SHA (`GET repos/{R}/commits/{sha}/check-runs?check_name=fleet/review`).
   If one already concluded `success`, the review is skipped entirely — never re-run for an
   unchanged head. A prior `failure`/`neutral`/in-progress run is never treated as fresh.
2. **Works out the review set.** `decideReviewSet` (`ci.ts`) — the *same* function the CI
   gate calls, not a copy — from the PR's `-reviewer` labels **and from the diff itself**, so
   a crypto diff gets `crypto-security-reviewer` whether or not anybody labelled it. Each
   profile is resolved to an agent definition in the local checkout's `.claude/agents/`.
   If any required profile cannot be run (missing, malformed, or unreadable definition), the
   command **refuses** — `review-set-unrunnable`, nothing spent, nothing posted. It will not
   post a `fleet/review` for a narrower set than the PR requires.
3. **Otherwise, review — the whole set.** Exports the head commit with
   `git archive | tar -x` (no `.git`, nothing executed), strips agent-control files, and runs
   the mandatory general non-author review *plus every profile in the set* concurrently
   (`Promise.allSettled`) against that one read-only export. The engine is **kimi**
   (`reviewPrimaryEngine()`, default `kimi`); `FLEET_REVIEW_PRIMARY=claude` is still the
   operator dial, and whenever claude runs — as the fallback arm, or under that dial — it
   runs at `opus`, deliberately a different tier than the `sonnet` a dispatched worker
   authors with. Reuses `review.ts`'s own prompt construction, engine invocation and
   export/strip helpers, and `specialist.ts`'s `buildProfileReviewPrompt`, rather than a
   second copy of any of them.
4. **Composes one verdict.** `composeReviewSet` (`ci.ts`), again the same function the gate
   uses: **ANY FAIL FAILS**, and an UNREADABLE is a failure too, so a profile's verdict can
   never be outranked by the general reviewer's PASS. A reviewer that throws is recorded as
   its own UNREADABLE rather than discarding the others' verdicts.
5. **Records the verdict.** Posts a real check-run named `fleet/review` on that head SHA —
   `success` only for a PASS verdict; `failure` for FAIL or an unreadable/ambiguous verdict.
   This is the one call that cannot use the operator's `gh` credentials: the Checks API
   refuses a PAT, so it authenticates as the `llamenos-fleet-review` GitHub App (#1483) —
   see "Credentials" below.
6. **Merges, if ready.** Re-reads the PR's required checks (`gh pr checks <pr> --required`)
   and merges (`--squash --delete-branch`) only if: the head has not moved since the review,
   `fleet/review` itself is passing, and every OTHER required check is green. A bot-authored
   PR (the fleet's own workers) always stops here with a message instead of merging — a
   human code-owner must approve it; this command never approves on the operator's behalf.

## Credentials — and why the command is non-functional without them (#1483)

The Checks API will not accept a personal access token
(`You must authenticate via a GitHub App. (HTTP 403)`), so recording the verdict needs the
`llamenos-fleet-review` GitHub App. Two values, documented with the fleet's other
credentials in `orchestrator/README.md` ("Recording a verdict"):

- `FLEET_REVIEW_APP_ID` — the App's numeric ID, a line in `~/.llamenos-fleet/env`. Not secret.
- `~/.llamenos-fleet/review-app.pem` — the App's private key, **mode 600**. Secret.
  Path overridable with `FLEET_REVIEW_APP_KEY_PATH`.

Until both exist, **`review-and-merge` does nothing useful**: it refuses *before* invoking
the reviewer (`cannot-record`), posts nothing, and exits non-zero. Use the CI gate instead
— request a review on the PR. If the credentials are present but the post fails anyway, the
command reports `review-unrecorded`: the review RAN, its verdict is LOST, nothing was
posted and nothing was merged. It never prints "posted" for a post that did not happen.

There is deliberately **no fallback**. `POST …/statuses` on a commit does accept a PAT and
does satisfy a required context, but a PAT-written green status under the `fleet/review`
name could override a red check run — fail-open, and rejected permanently on #1483. Rails
in `tests/orchestrator/guards.test.ts` bind the App token to one file, the key to one file,
and forbid a commit-status write anywhere in `orchestrator/src`.

## Idempotency and failure modes

Running the command twice against an unchanged head does no second review and no second
merge attempt — an already-merged PR is detected up front and the command exits
immediately. Every other early return is an explicit refusal with a stated reason (head
moved, checks unreadable, a required check red, an unreadable review verdict, a review set
that cannot be worked out or cannot be run, no usable App credentials, a verdict that could
not be recorded) — there is no path that merges on a guess, and none that loses a verdict
quietly.

## Why this command is the escape hatch for a code-owned PR (#1637)

A PR that touches a path owned by its required reviewer, carries a standing FAIL or no
earned verdict, **and** needs a reviewer profile beyond the general review used to have no
route back to green: `review_requested` never fires (GitHub re-adds a CODEOWNER's request
the instant it is removed — #1471), `synchronize` is structurally limited to republishing
(`republishOnly`, `ci.ts`), and this command refused outright. Running the full review set
here is what opens that route. The refusal is not gone — it moved to the one honest trigger
for it, a required reviewer that cannot be run at all.

## Usage

```bash
bun orchestrator/src/cli.ts review-and-merge <pr-number>
# or, once linked:
llamenos-fleet review-and-merge <pr-number>
```

Exit code 0 only for an actual merge (or a PR already merged); non-zero for every refusal,
so it is safe to script around.
