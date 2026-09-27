# Llámenos Fleet — unattended agent dispatch

## What this is

A scheduled dispatch loop that reads open GitHub issues labelled
`agent-dispatchable` from `rhonda-rodododo/llamenos-platform`, routes each one
to a lane (`backend`, `shared`, `desktop`, `ios`, `android`, `infra`) based on
its `lane:<id>` label, and — once live dispatch ships in the follow-on plan —
hands it to an agent scoped to that lane's owned paths.

Every 30 minutes, `llamenos-fleet tick` runs one pass: it checks the kill
switches and circuit breakers, lists candidate work per lane, judges each
candidate against that lane's rules, claims exclusively (an item labelled for
two lanes goes to the higher-priority one, never both), and then — per lane
mode — either records what it *would* dispatch (`shadow`) or dispatches for
real (`live`).

## What this is not

- **Not live yet.** Live dispatch, PR verification, the review loop, the
  digest, and notifications are the follow-on plan
  (`.superpowers/sdd/2026-09-11-fleet-live-dispatch.md`). Right now every
  lane's `dispatch()` is a placeholder that throws, and the CLI additionally
  refuses to even attempt a pass while any lane is set to `live` — see
  "Kill switches" below.
- **Not a CI system.** It does not run tests, merge PRs, or gate anything.
  Verification and merge are the follow-on plan's job.
- **Not autonomous end-to-end.** It only *selects and would dispatch* work.
  A human still reviews and merges every change through normal PR review —
  the fleet was designed so it can never merge its own changes (see rail 2
  below).

## Safety properties asserted in this branch

**This is not the spec's "eight rails."** The design spec
(`docs/superpowers/specs/`) defines eight rails: (1) non-author verification,
(2) one scheduler, (3) a phone-reachable stop, (4) circuit breakers, (5) a
rehearsed revert, (6) the worker runs in its own worktree, (7) lane modes,
(8) live-lane write scope. **This branch does not implement spec rails 1
(non-author verification), 5 (rehearsed revert), or 6 (worker-in-its-own-
worktree)** — there is no live dispatch yet, so there is no worker output to
verify, no worktree to isolate, and nothing to revert. Those three ship in
the follow-on live-dispatch plan.

What follows is the list of safety properties this branch *does* assert and
unit-test today, in `tests/orchestrator/guards.test.ts` — a reviewer can read
that one file to see every one of them in one place. Rows 1, 7, and 8 below
are spec rails 8 and 7; row 5 is the GitHub-fails-open half of spec rail 3
(phone-reachable stop). Rows 2, 3, 4, and 6 are properties specific to this
branch's shadow-pass scaffolding, not one of the spec's numbered eight.

| # | Property | Owning file |
|---|------|-------------|
| 1 | A `live` lane must have a non-empty write scope, enforced at load time (not merely tested) — a live lane with an empty `owned` list gives the scope breaker nothing to compare a diff against. (Spec rail 8, live-lane write scope.) | `orchestrator/src/config.ts` (`assertLiveLanesHaveScope`), scope parsed by `orchestrator/src/fragments.ts` |
| 2 | The fleet cannot merge its own changes — `orchestrator/` and `tests/orchestrator/` are always high-impact, so a change there can never auto-merge and always reaches a human. **Implemented and unit-tested; wired into the merge/verify path in the follow-on plan** — `classifyImpact` has no runtime caller on this branch today, only test callers. | `orchestrator/src/impact.ts` (`HIGH_IMPACT_PATHS`, `classifyImpact`) |
| 3 | Crypto, protocol schemas, crypto labels, and DB migrations always reach a human, regardless of which lane touched them. Same caveat as above: asserted by `classifyImpact`, which is not yet called anywhere at runtime. | `orchestrator/src/impact.ts` |
| 4 | The never-write list classifies secrets, keystores, and PEM/SSH key files as forbidden for even a lane with no declared scope at all. **Implemented and unit-tested; wired into the merge/verify path in the follow-on plan.** `NEVER_WRITE_PATHS` and `checkScope` are a post-hoc diff classifier, not a write barrier, and have no runtime caller on this branch — so the previous claim that these paths are "unwritable by any lane, unconditionally" was wrong; nothing on this branch stops a write to them from happening in the first place. | `orchestrator/src/config.ts` (`NEVER_WRITE_PATHS`), `orchestrator/src/scope.ts` (`checkScope`) |
| 5 | The GitHub kill switch fails **open**: if the halt-label issue list cannot be read, that is treated as "not halted," not as a halt — an API outage must never look like a silent full stop. | `orchestrator/src/killswitch.ts` (`haltedOnGitHubFrom`) |
| 6 | Exactly one git remote (`origin` → `llamenos-platform`) — a second remote makes it possible to dispatch work at the wrong repository. | `orchestrator/src/gh.ts` (pinned `REPO`), asserted by `llamenos-fleet doctor` and by `tests/orchestrator/guards.test.ts` |
| 7 | Every lane ships `off` by default — no lane is live or shadow out of the box. (Spec rail 7, lane modes.) | `orchestrator/src/config.ts` (`LANES`) |
| 8 | Lane modes are runtime state, never source: turning a dial does not require a human-gated PR to `orchestrator/`, and "every lane starts off" cannot go stale because a mode got hardcoded. (Spec rail 7, lane modes.) | `orchestrator/src/config.ts` (`LANE_MODES_FILE`, `readLaneModes`) — see "Changing a lane's mode" below |

Two more mechanisms sit underneath the list above and are exercised
throughout `tests/orchestrator/`: the single-scheduler pidfile lock
(`orchestrator/src/lock.ts` — spec rail 2, "one scheduler") and the circuit
breakers for dispatch rate and consecutive failures
(`orchestrator/src/circuit.ts` — spec rail 4, "circuit breakers"). Unlike
rails 2 and 4 in the table above, these two run for real on every `tick()`
call today — they are not deferred to the follow-on plan.

## The two kill switches — opposite failure modes, on purpose

| Switch | File | Fails... | Why |
|--------|------|----------|-----|
| **Local halt file** | `~/.llamenos-fleet-disabled` (plus reason in `~/.llamenos-fleet/halt-reason.txt`) | **CLOSED** | A file that exists stops the fleet, and needs no network. This is the switch for "I am at the machine and something is wrong right now." |
| **GitHub halt label** | An open issue labelled `halt` in `llamenos-platform` | **OPEN** | If the issue list cannot be read (API outage, auth failure), that is treated as *not halted*. This is the switch you can pull from a phone, and a network blip must never turn into an invisible, un-alarmed full stop of the fleet. |

Both are checked before every pass (`checkHalt()` in `tick()`), and the
GitHub check is re-checked **between every individual dispatch**, not just
once per pass — a stop takes effect within one worker, not within one
30-minute tick.

There is deliberately no third "soft halt": `halt()` and `resume()` are the
one recovery path for both switches' visible state (the reason file and the
resumed-at marker), so an operator never has to remember two different ways
to clear two different halts.

## Commands

All commands go through the wrapper installed at `~/.local/bin/llamenos-fleet`
(a symlink to `orchestrator/bin/llamenos-fleet`, which resolves the repo root
through the symlink and execs `bun orchestrator/src/cli.ts`). Equivalently,
from the repo root: `bun run fleet <command>`.

| Command | What it does |
|---------|--------------|
| `llamenos-fleet doctor` | Runs every health check (`gh` auth, repo readable, exactly one git remote, every lane has a non-empty parsed scope, not halted, command on `PATH`, last tick pass did not error) and prints current lane modes. Exits non-zero if any check fails. |
| `llamenos-fleet status` | Prints halted state, dispatch outcome counts from the last 24h of the ledger, the configured limits, and whether the last recorded tick pass errored. Exits non-zero if the last tick pass ended in `aborted: 'error'`. |
| `llamenos-fleet tick` | Runs one dispatch pass. Refuses outright (exit 1, no pass run) if any lane's mode is `live` — see "Live dispatch is not implemented" below. Otherwise runs `tick()`, logs the JSON result to `~/.llamenos-fleet/fleet.log`, and prints a human-readable summary: `ran`, `attempted`, `failed`, `shadowed`, and the rejection count. Exits non-zero if the pass itself errored (`aborted: 'error'`). |
| `llamenos-fleet halt "<reason>"` | Writes the local halt file and reason, and logs `HALTED`. |
| `llamenos-fleet resume` | Clears the local halt file and reason, records a resume timestamp (which resets the consecutive-failure breaker's window), and logs `RESUMED`. |

### `attempted` vs `failed` vs `shadowed`

- `shadowed` — items a lane in `shadow` mode *would* have dispatched; nothing
  was attempted.
- `attempted` — every real `dispatch()` call made (lanes in `live` mode
  only), whether it succeeded or threw. **This is not a success count.**
- `failed` — the subset of `attempted` that threw and was recorded as a
  `FAILED` ledger row.

`attempted` was named `dispatched` in an earlier draft of this code; it was
renamed because "N dispatched" reads as "N succeeded," which is false the
moment any of them throw — a thrown dispatch is caught, recorded `FAILED`,
and the pass continues rather than aborting.

### Live dispatch is not implemented yet

Live dispatch (an agent actually picking up an issue and opening a PR)
ships in the follow-on plan. Until then:

- `llamenos-fleet tick` checks every lane's mode **before** doing anything
  else. If any lane is `live`, it prints which lane(s) and exits 1 without
  running a pass at all — it does not even read GitHub or take the lock.
- If that guard were ever bypassed, the `dispatch()` implementation wired
  into `tick()` is a placeholder that always throws
  (`live dispatch not implemented — keep lanes in shadow mode`). That
  placeholder is a second line of defence only; the CLI-level refusal above
  is what an operator will actually see.
- **`shadow` is the only mode with real content today.** `off` does nothing;
  `live` is refused.

## Specialist reviewers (#1092)

A PR label ending in `-reviewer` requests a specialist. For example,
`crypto-security-reviewer` runs the agent defined at
`.claude/agents/crypto-security-reviewer.md` against the PR. It posts its
verdict as the check `fleet/review/crypto-security-reviewer` (workflow
`.github/workflows/fleet-specialist-review.yml`, CLI `specialist-review-ci`,
code `src/specialist.ts`).

- **Adding a specialist** takes an agent definition whose frontmatter `name:`
  equals the label. Merge it to `main` first, because the registry is read from
  the PR's base. Then create a label of the same name. The workflow needs no
  change.
- **Triggering it:** apply the label. Only `labeled` triggers a run, never a
  push. To re-request a review, re-apply the label.
- **Fail closed:** an unknown or malformed `-reviewer` label fails its check.
  It is never skipped.
- **Never a required context.** A check that runs only when a label is present
  would block every unlabelled PR. It binds at the merge decision instead,
  and any FAIL fails:
  - the required `fleet/review` gate fails while a requested specialist has no
    PASS for the PR's diff;
  - requesting a specialist disarms the PR's auto-merge;
  - `board` and `review-and-merge` refuse on any failing, in-flight, or
    requested-but-absent `fleet/review/*` check.
- **Order:** apply the specialist label, wait for it to pass, then (re-)apply
  `review`. Clearing a specialist FAIL takes a new head.

## Changing a lane's mode

Lane modes are **runtime state, never source** (rail 8). Never edit
`orchestrator/src/config.ts` to turn a dial — `orchestrator/` is high-impact
(rail 2), so any change there needs a reviewed PR, and baking a mode into
source would also make the "every lane starts off" guard test false the
moment anyone turned one on.

Instead, write (or edit) the JSON file at:

```
~/.llamenos-fleet/lanes.json
```

For example, to put `backend` and `shared` into shadow mode and leave the
rest off:

```bash
mkdir -p ~/.llamenos-fleet
echo '{"backend":"shadow","shared":"shadow"}' > ~/.llamenos-fleet/lanes.json
```

Valid values per lane are `"off"`, `"shadow"`, `"live"` (though `tick`
currently refuses to run at all if any lane is `"live"` — see above). Keys
that are not one of the six lane ids — including `__proto__`, `constructor`,
and `prototype` — are ignored and reported to the fleet log as unknown lane
ids; an absent or unreadable file falls back to `off`, never to some other
default. Lookups never consult the map's prototype chain, so a poisoned key
can never turn an unlisted lane on.

A lane entry may also be an object that overrides the dispatch engine and
model for that lane, e.g. to run a lane on opencode/Kimi while the Anthropic
account's quota is exhausted:

```json
{"backend": {"mode": "live", "engine": "opencode", "model": "kimi-for-coding/k3-256k"}}
```

Allowed keys are exactly `mode`, `engine`, `model`; `engine` is `"claude"`
(the default) or `"opencode"`. A raw opencode provider/model id is mapped to
the dispatcher's token form (`kimi-for-coding/k3-256k` → `kimi`, anything
else → `opencode:<id>`); dispatcher tokens pass through untouched. `--effort`
is omitted for opencode lanes (the dispatcher only supports it for Claude).
Any malformed entry — unknown key, invalid mode or engine — fails CLOSED:
that lane stays `off` and the rejection reason is written to the fleet log.
`llamenos-fleet doctor` prints each lane's mode/engine/model and fails if a
`live` opencode lane has no `opencode` binary on PATH.

## Where state lives

Everything the fleet reads or writes at runtime lives under
`~/.llamenos-fleet/` (`FLEET_DIR` in `orchestrator/src/paths.ts`), with one
deliberate exception:

| Path | What |
|------|------|
| `~/.llamenos-fleet-disabled` | The local halt file (existence-only; see "Kill switches"). Deliberately **outside** `~/.llamenos-fleet/`, in `$HOME` directly, so a human who doesn't know where the fleet keeps its state can still stop it with a bare `touch`. |
| `~/.llamenos-fleet/halt-reason.txt` | Free-text reason for the current local halt. |
| `~/.llamenos-fleet/resumed-at` | Timestamp of the last `resume`. The consecutive-failure breaker only counts ledger rows after this point, so a resume actually clears the streak instead of the very next failure re-tripping it. |
| `~/.llamenos-fleet/lanes.json` | Runtime lane mode overrides — see "Changing a lane's mode." |
| `~/.llamenos-fleet/scheduler.lock` | Pidfile lock; ensures only one `tick()` runs at a time. Stale locks (holder process no longer alive) are reaped automatically. |
| `~/.llamenos-fleet/runs.jsonl` | The ledger — one JSON line per dispatch/shadow/rejection-relevant outcome. Read by `status`, the circuit breakers, and the per-item attempt limit. |
| `~/.llamenos-fleet/fleet.log` | Plain `<timestamp> <message>` log, one line per event plus one JSON-encoded `TickResult` line per pass. `doctor` and `status` tail this file to report whether the *last* pass errored. |
| `~/.llamenos-fleet/env` | Optional. Sourced by the `bin/llamenos-fleet` wrapper (`set -a; . env; set +a`) before exec — secrets live here, never in git. Also referenced by the systemd unit's `EnvironmentFile=-%h/.llamenos-fleet/env` (the leading `-` makes it optional). |

## systemd timer

Unit files are at `orchestrator/systemd/llamenos-fleet-tick.{service,timer}`.
**They are not installed or enabled by this plan** — that step is left to a
human. The units are systemd *user* units: `%h` is the owner's home directory,
and they run `%h/.local/bin/llamenos-fleet` — a symlink into this checkout
(`llamenos-fleet doctor` prints the exact `ln -sf` command if it is missing).
The wrapper `cd`s into the checkout itself, so no path to the checkout is
written into the units and it can live anywhere. To install (when ready):

```bash
mkdir -p ~/.local/bin ~/.config/systemd/user
ln -sf "$PWD/orchestrator/bin/llamenos-fleet" ~/.local/bin/llamenos-fleet
cp orchestrator/systemd/*.service orchestrator/systemd/*.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now llamenos-fleet-tick.timer
systemctl --user list-timers 'llamenos-fleet-*'
```

Expect a real `NEXT` time in the last command's output — never `infinity` or
a blank column. The timer uses an absolute `OnCalendar` schedule
(`*-*-* *:00,30:00`), deliberately not `OnBootSec`/`OnUnitActiveSec`: the
latter anchors off the last activation or boot, and a machine that has been
up for days with no recent activation would have nothing to anchor to —
systemd would then schedule nothing at all while `is-enabled`/`is-active`
still both say yes. An `OnCalendar` expression always has a next occurrence
computed from the clock alone, so it cannot enter that state.

The service unit sets `SuccessExitStatus=0` and does not treat a pass that
declined to run (lock held, halted, breaker tripped) as a failure — those
are `tick()` working as designed, not a fault for systemd to back off on.

## First shadow pass — result

Run by hand on 2026-09-12, all six lanes in `shadow` mode
(`~/.llamenos-fleet/lanes.json`: every lane `"shadow"`).

**`attempted: 0` on every run, for every lane, throughout.** No lane was in
`live` mode, so no real `dispatch()` call was ever going to happen — that
part was true from the start and stays true.

The label taxonomy (`agent-dispatchable`, `lane:<id>`, `needs-human`, etc.)
was created, and three smoke issues were then filed against real GitHub to
actually exercise `selectForLane`'s selection and rejection paths, not just
assert them against synthetic fixtures:

- **#634** — a normal, correctly-labelled candidate. Produced a `SHADOW` row
  on the `infra` lane (`shadowed: 1`) — the first real evidence that a real
  GitHub issue flows all the way through selection, claim, and the shadow
  record path.
- **#635** — a candidate with a too-short body. Rejected `body-too-short`.
- **#636** — a candidate carrying a veto label. Rejected `vetoed`, in every
  lane it was visible to.

All three issues are now closed. Full detail (candidate counts and rejection
histograms per lane) is in
`.superpowers/sdd/2026-09-11-fleet-core/task-14-15-report.md`.

**What remains unexercised:** multi-item claim contention (two lanes both
able to claim the same issue — `claimAcrossLanes`'s priority-order behavior
is unit-tested but has not been observed against real concurrent GitHub
data) and cap enforcement against real data (no smoke issue count has yet
exceeded a lane's `cap`). Both are exercised only by synthetic tests today,
not by this pass.

**Scope check (rail 1) per lane**, compared against
`.claude/agents/fragments/<lane>-supervisor.md`:

- `backend`: `apps/worker/`, `apps/sip-bridge/`, `apps/signal-notifier/`,
  `tests/features/`, `tests/steps/`. **`apps/sip-bridge/` and
  `apps/signal-notifier/` do not exist** — the real directories are
  `sip-bridge/` and `signal-notifier/` at the repo root. A fix is in PR #633,
  unmerged as of this pass. Until that lands, backend's live scope would be
  narrower than intended (missing the SIP bridge and Signal notifier
  entirely) rather than wrong in a dangerous direction — the paths it thinks
  it owns simply don't exist, so it could never accidentally write there.
- `shared`, `desktop`, `ios`, `android`, `infra`: parsed scopes matched their
  fragments' "Owned paths" sections exactly (see
  `task-14-15-report.md` for the full parsed output of every lane).

## The resume command, in full

```
llamenos-fleet resume
```

This clears **both** halt mechanisms' local state in one step: it removes
`~/.llamenos-fleet-disabled` and `~/.llamenos-fleet/halt-reason.txt`, then
writes the current timestamp to `~/.llamenos-fleet/resumed-at`. That
timestamp resets the consecutive-failure breaker's window — failures from
before the resume no longer count toward tripping it again. It does **not**
remove the GitHub `halt`-labelled issue if that is what's stopping the fleet;
close or unlabel that issue on GitHub directly. Run `llamenos-fleet doctor`
afterward to confirm `not halted` reports `ok`.
