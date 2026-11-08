---
name: supervising-dispatched-sessions
description: Use when the user puts you in a supervisor role coordinating multiple long-running PR fixes, merge trains, CI monitoring, or batch overnight work — you dispatch isolated Claude/Copilot/opencode sessions via tmux+launcher scripts instead of doing the work yourself, and resume by reading status files in a fresh session
---

# Supervising Dispatched Sessions

**Role: coordinator only.** Never do work yourself — dispatch workers. Stay responsive to the user.

## Setup (run once per session)

```bash
export S=~/.copilot/skills/supervising-dispatched-sessions  # Copilot CLI
# export S=~/.claude/skills/supervising-dispatched-sessions  # Claude Code (same dir via symlink)
bash $S/bootstrap.sh  # reads handoff file, dstat, git state, open PRs
```

## Dispatch

```bash
# Write brief (~10 lines: title + context + task), then:
$S/dispatch-one.sh <name> <brief.md> [timeout-sec] [model] [worktree-path]
$S/dispatch-one.sh --template pr-comments <name> <brief.md> [timeout] [model]
$S/dispatch-one.sh --agent <agent-name> <name> <brief.md> [timeout] [model]  # Claude workers only

# PR triage: auto-generate brief first
$S/generate-pr-brief.sh <pr-number>

# Different repo
DISPATCH_REPO=/path/to/repo WORKTREE_BASE=/path/to/projects $S/dispatch-one.sh ...
```

**Flags:** `--template standard|kb|pr-comments` (standard=default) · `--no-template` · `--rules <name>` (auto-detected from the repo path) · `--no-rules` · `--agent NAME` · `--effort low|medium|high|xhigh|max` (default `high`; Claude runtimes only — other runtimes warn and ignore) · `--max-budget-usd N` (Claude only) · `--owns 'path,path'` (FILE OWNERSHIP block — pass it whenever 2+ workers are live on one repo) · `--card <trello-card-id>` (mirror this worker onto a board card) · `--no-card` · `--dry-run` (print the assembled prompt and exit — creates nothing)

**Audit a template change without spending a dispatch:** `--dry-run` assembles the prompt, prints it and exits — no worktree, no branch, no tmux session. Verify a rule reaches the worker by grepping that output. Never "test" a prompt change by launching a real worker.

## Subagents vs tmux workers

The supervisor has TWO dispatch tiers. Both count as "dispatching" — the coordinator never does the work itself either way.

**Native subagents** (Claude: Task tool · Kimi: Agent tool) — for short, bounded work:
- < ~30 min, in the CURRENT repo checkout (no worktree needed)
- Read-only exploration, code review, spec/audit review, writing a brief, one focused edit
- You need the result back in this conversation (foreground) or soon (background notification)
- Limits: subagents die with the supervisor session, can't be resumed, and run the SUPERVISOR's model (a kimi supervisor gets kimi subagents — model routing below doesn't apply to them). Don't run 2 subagents that write the same files in parallel.

**Tmux workers** (`dispatch-one.sh`) — for heavy or long-lived work:
- > 30 min, 3+ parallel, or overnight
- Needs isolation: own worktree, own branch, own PR
- Must survive supervisor restart (status files + dstat/dinspect are the interface)
- Needs a different model/quota than the supervisor (see model-routing.md)
- Keeps the supervisor responsive — never block a turn waiting on a worker

Rule of thumb: if you'd want the result even after this session ends, or it costs more than a coffee break, it's a tmux worker. Everything else is a subagent.

**Models:** (model = how hard the reasoning is; `--effort` = how expensive a wrong answer is. They are independent — see the effort-routing table in `model-routing.md`.)

| Token | Runtime |
|-------|---------|
| `opus` | Claude (heavy reasoning) |
| `sonnet` | Claude (default model) |
| `fable` | Claude |
| `haiku` | Claude (fast/cheap) |
| `glm` | Claude CLI → GLM-5.3 at z.ai (off Max quota) |
| `glm:<model>` | same, pinned — e.g. `glm:glm-5.3-flash` |
| `kimi` / `kimi-thinking` | opencode |
| `opencode:<provider/model>` | opencode |
| `copilot` | Copilot CLI (auto model) |
| `copilot:claude-sonnet-4.6` | Copilot CLI |
| `copilot:claude-haiku-4.5` | Copilot CLI |
| `copilot:gpt-5.4` / `copilot:gpt-5.4-mini` | Copilot CLI |
| `copilot:gemini-3.5-flash` | Copilot CLI |
| `kimi-cli` | Kimi Code CLI (default model) |
| `kimi-cli:<model>` | Kimi Code CLI |

See `model-routing.md` for heuristics. Copilot and kimi-cli workers: `--agent` flag not supported; omit it. `glm` workers behave exactly like Claude workers (same agent loop, `--name`, `--agent`, skills) but need `ZHIPU_API_KEY` set — the dispatcher fails fast if it is missing.

## Status

```bash
dstat               # all workers, last 4h (fallback: bash $S/status.sh)
dstat --24h / --all
dstat --porcelain   # raw `name|state|pid|pr|elapsed|started|note` rows, for scripts
dinspect <name>     # deep: PID/CPU/MEM, tmux pane, log events, status file, worktree git
dinspect <name> --lines 60 / --raw / --repo <path>   (fallback: bash $S/inspect.sh <name>)
```

**Never parse the rendered `dstat` table.** It is padded by `column -t -s '|' -o '|'`, so
`awk '{print $1}'` returns a literal pipe and a substring grep for `RUNNING` also matches
note text and the footer. Use `--porcelain`.

**Reading the states.** `dstat` reconciles the status file against liveness, because a
status file is a claim and a live process is an observation:

| State | Means |
|---|---|
| `RUNNING` / `EXITING` | process alive / tmux session alive but runtime gone |
| `SUCCESS` `BLOCKED` `FAILED` `PARTIAL` `NEEDS_CONTEXT` | the worker wrote a terminal status |
| `DISPATCHED` | seeded at launch; the worker has not written its own status yet |
| `UNCONFIRMED` | the launcher's fallback writer ran — the runtime exited but the worker never wrote a terminal status. `notes:` carries the runtime's subtype/turns/cost and its final message |
| `DEAD(exited-clean)` | non-terminal status, nothing running, but the log HAS a terminal `{"type":"result"}` object: the run finished, the worker just never said so |
| `DEAD(no-result)` | non-terminal status, nothing running, no result object in the log |

A `~` in the elapsed or time column means the value came from a file mtime (last update),
not a measured start time or run duration. Claude worker logs carry no timestamp prefix, so
`started` is only real when it came from the `dispatched_at` seed.

## What actually goes wrong with workers (measured, 2026-08-30)

27 workers dispatched against one repo in a day; 2,422 tool calls audited across their logs.

**Workers do not crash.** All 25 terminated workers that day ended
`success`/`completed` with `is_error:false`. Not one died, errored, or hit its wall
clock. **The failure mode is a worker that COMPLETES while believing something will wake
it up.** Six workers had already committed, pushed and opened a PR, then ended their turn
waiting on a backgrounded job — under `claude --print` there is no next turn and no
notification loop, so no terminal status was ever written. Each looked exactly like a
death and cost a forensic audit. Hence: Rule A (`_rule_one_shot`, in every template), the
launcher's fallback status writer, and the `DISPATCHED` status seed.

**Two prompt bans are measured-effective — do not add more text for them.** Across those
2,422 tool calls there were **0** `Agent`/`Task` invocations and **0** executed
`bunx vitest` calls (106 correct `node node_modules/vitest/vitest.mjs`). Both rules are
already working; more words about them only crowd out rules that are not.

**Dispatch guidance that follows from this:**

- **Tag any brief that runs a full test tier**, and keep **at most two** such workers in
  flight. The tiers are CPU-bound and contend; contention inflates failures, and a worker
  that mistakes contention for a regression will "fix" something that was never broken.
- **Give test-tier workers a generous timeout.** `dependency-graph-repair` ran 8,806s
  against a 9,000s limit — 3.2 minutes of margin on a 2.5-hour job.
- **Pass `--owns` whenever 2+ workers are live** on one repo. It is the only thing between
  two workers and the same file.
- **Trust the status file over the log tail**, and the reconciled `dstat` state over both.

## Handoff (context ~250k tokens or after auto-compression)

Signs: 8+ workers dispatched · 3h+ session · messages summarized · slower responses.
Copilot CLI: run `/compact` proactively before it degrades.

```bash
bash $S/handoff.sh "notes on what's next"
# Tell user: state saved to ~/tier-supervisor-handoff.md
# Resume: copilot --name supervisor  OR  claude --name supervisor → say "continue"
```

## Trello board as work queue

Trello owns work-item state; git owns authored content. The **Atlas MedCode Product
Engineering** board (`6a5f85e156fcd7c314bfa382`) is the work inventory — what exists,
who's on it, what's blocked. Agents may move cards on that board automatically; on the
GTM and Sales boards, humans move cards.

```bash
bash $S/trello-queue.sh                      # read the queue (read-only, DEFAULT)
bash $S/trello-queue.sh --dispatch --dry-run # preview what would be dispatched
bash $S/trello-queue.sh --dispatch --yes     # dispatch from the board, cap 3
bash $S/trello-queue.sh --reconcile          # In Review → Done for approved/merged PRs
$S/dispatch-one.sh --card <id> <name> <brief.md> [timeout] [model]   # one card by hand
```

`bootstrap.sh` surfaces Next-up + drift; `--card` mirrors a worker's lifecycle onto its
card (In Progress at dispatch → PR comment + attachment the moment a PR opens → In Review /
Blocked / Next-up at exit → Done once the PR is approved or merged). Card ops never fail a
dispatch — all errors swallowed to `~/trello-mirror.log`.

**Where the human gate lives.** On the **engineering** board it is the **PR review**: agents
move In Review → Done by *reading* `gh pr view` and seeing merged/approved. No agent
approves or merges a PR, and a card never moves on an unreadable PR state. A second,
card-level hand-move after GitHub already reviewed the work is ceremony that gets abandoned,
so it isn't built. On the **GTM / Sales** boards the opposite holds: only a human moves a
card out of "Review (yay or nay)" — automation there can comment and nothing else, enforced
by the board guard. Once a human has released a GTM card, agents may finish the rest of it.

Rails, all enforced in code: only `agent-dispatchable` cards are auto-selected;
`needs-human`/`needs-decision` never are; engineering board only (GTM/Sales accept
comments and nothing else); cap 3 concurrent; completion is read from GitHub, never caused
by an agent; kill switch `touch ~/.trello-dispatch-disabled`. Unattended/scheduled running
is **not enabled** and is not an agent's call to make.

Never put PHI, secrets, or KB/strategy internals (ADR-013) on a card. Design:
`docs/superpowers/specs/2026-07-21-trello-session-integration.md` and
`…/2026-07-21-board-driven-dispatch.md` (repo).

## Idle queue

```bash
bash $S/sweep-comments.sh  # surface unanswered PR review comments; offer to dispatch, never auto-dispatch
```

## Allowed commands (only these)

`dstat` · `dinspect <name>` · `gh pr view/checks` · `bash $S/bootstrap.sh` · `bash $S/sweep-comments.sh` · `bash $S/generate-pr-brief.sh` · `tmux kill-session -t <name>` · `trello cards list/create/move` + `trello comments create` (Product Engineering board only)

**Never:** edit files · run git/build/test/lint · read stack traces or diffs · grep codebase · `pkill -f claude|opencode|copilot` (kills all sessions). Kill workers with `tmux kill-session -t <name>` only.

## Report format

≤5 lines · columns: PR# | status | blocker | next-action · no log pastes
