# Shared supervisor sources

`.claude/agents/build-agents.sh` composes every generated
`.claude/agents/<lane>-supervisor.md` from three in-repo inputs:

1. the lane fragment — `.claude/agents/fragments/<lane>-supervisor.md`
2. the shared worker rules — `.claude/agents/fragments/_worker-rules.md`
3. the four files in this directory:
   - `SKILL.md` — core dispatch protocol (its leading YAML frontmatter is stripped)
   - `model-routing.md` — model routing reference for dispatched workers
   - `prompt-rules-llamenos.md` — Llámenos worker rules
   - `prompt-template.md` — worker prompt template

These four used to be read from the operator's machine at
`$HOME/.claude/skills/supervising-dispatched-sessions/`. That copy carries machine-local
paths and private tooling notes, so the build either failed its own leak check or would
have published them, and nobody could re-run it. When #2557 rewrote the write-gate rules in
`_worker-rules.md`, the six assembled files kept describing the old gate (#2559).

**This directory is the source of truth for this repo.** It is not a mirror that
auto-updates. When the operator's upstream copy changes and the change belongs here, port it
by hand, keeping it free of machine-local paths and private tooling (use `$DISPATCH_REPO`,
`$WORKTREE_BASE`, `~`).

**Never edit a generated `.claude/agents/<lane>-supervisor.md` by hand.** Edit its source,
then:

```sh
bun run agents:build   # regenerate all six
bun run agents:check   # exit 1 if any committed output differs from its sources
```

`tests/orchestrator/shared-fragment.test.ts` runs the check inside `bun run test:fleet`,
so a stale output fails the fleet suite in CI.
