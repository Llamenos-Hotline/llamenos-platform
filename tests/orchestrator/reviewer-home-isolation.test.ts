import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  REVIEWER_CREDENTIALS_RELPATH,
  REVIEWER_HOME_PREFIX,
  REVIEWER_TOOLS,
  invokeVerifierEngine,
  prepareReviewerHome,
  verifierArgs,
} from '../../orchestrator/src/review.js'

/**
 * Rail for #1460 / #1511: the reviewer session must load NO configuration
 * the gate did not name.
 *
 * The defect, stated precisely: `--tools Read,Grep,Glob` (#1458) restricts
 * the engine's BUILT-IN tool set and nothing else. It does not filter MCP
 * tools, and it does not stop the engine reading the invoking user's own
 * configuration out of `$HOME`. On `llamenos-review-box` — self-hosted, so
 * not a fresh VM — that configuration is the operator's, and three parts of
 * it reached into every review:
 *
 *   - MCP servers, arriving as extra callable tools regardless of `--tools`.
 *     A write-capable one means the read-only reviewer is not read-only.
 *   - `settings.json` hooks, EXECUTING at session start, before the model
 *     says a word and independently of anything the gate decided.
 *   - user-level `CLAUDE.md` and skills, prepended as TRUSTED instructions.
 *     This is the half that blocked merges: the reviewer saw the operator's
 *     workflow instructions conflicting with the smoke step's fixed-string
 *     prompt, and declined it as a prompt-injection attempt — 3/3 runs on
 *     #1510, surfacing as `NO-VERDICT:engine-unavailable` (#1511).
 *
 * ## Why this file is behavioural and not a config read
 *
 * #1460 says so explicitly, and the project's standing rule says so
 * generally: do not verify this by reading the configuration, because the
 * whole defect is that the configuration looks fine. So this file plants
 * SENTINELS in a HOME the reviewer would previously have inherited — an MCP
 * server config and a `SessionStart` hook that writes a file — and asserts
 * the sentinels do not appear.
 *
 * The engine is a fake `claude` on PATH that emulates exactly the three
 * loading behaviours above, and is deliberately the SAME binary in the
 * fixed and the mutated runs. That is what makes a negative result mean
 * something: the mutations at the bottom show the same fake firing both
 * sentinels the moment the fix is removed, so "no sentinel" is evidence the
 * gate's isolation held, not evidence the harness never looked.
 */

/** The sentinel the fake engine's `SessionStart` hook writes, and the marker
 *  tool name a loaded MCP server contributes. Both are observable OUTSIDE
 *  the engine process — a file on disk and a line of stdout — so neither can
 *  be satisfied by the harness inspecting its own inputs. */
const HOOK_SENTINEL = 'sessionstart-hook-ran'
const MCP_MARKER_TOOL = 'mcp__marker__write_anything'

/**
 * Stands in for `claude`, emulating ONLY the HOME-derived loading this rail
 * is about, then emitting the `--output-format stream-json` envelope
 * `decodeEngineOutput` expects.
 *
 * It reports the tool set it would make available, which is the assertion
 * target for "the reviewer is still read-only": the built-in names from
 * `--tools`, PLUS every MCP server from `$HOME/.claude/mcp.json` unless
 * `--strict-mcp-config` was passed. It runs the `SessionStart` hook command
 * from `$HOME/.claude/settings.json` if one is there. And it reports whether
 * a user-level `$HOME/.claude/CLAUDE.md` was found, which is #1511's own
 * mechanism.
 */
const FAKE_CLAUDE = `#!/usr/bin/env bash
set -u
cat >/dev/null   # the piped prompt, read and discarded like the real CLI

strict=0
tools=""
prev=""
for arg in "$@"; do
  case "$prev" in
    --tools) tools="$arg" ;;
  esac
  if [ "$arg" = "--strict-mcp-config" ]; then strict=1; fi
  prev="$arg"
done

cfg="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

# 1. SessionStart hooks execute as part of session startup.
if [ -f "$cfg/settings.json" ]; then
  cmd="$(sed -n 's/.*"SESSIONSTART_COMMAND":[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$cfg/settings.json")"
  if [ -n "$cmd" ]; then sh -c "$cmd" >/dev/null 2>&1 || true; fi
fi

# 2. MCP servers become additional callable tools unless --strict-mcp-config.
available="$tools"
if [ "$strict" -eq 0 ] && [ -f "$cfg/mcp.json" ]; then
  for name in $(sed -n 's/.*"MCP_TOOL_NAME":[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$cfg/mcp.json"); do
    available="\${available:+$available,}$name"
  done
fi

# 3. User-level CLAUDE.md is prepended as trusted instructions.
memory="none"
if [ -f "$cfg/CLAUDE.md" ]; then memory="loaded"; fi

# 4. Authentication comes from the one credential file under the config dir.
auth="absent"
if [ -f "$cfg/.credentials.json" ]; then auth="present"; fi

printf '{"type":"system","subtype":"init","home":"%s","tools":"%s","memory":"%s","auth":"%s"}\\n' \\
  "$HOME" "$available" "$memory" "$auth"
printf '{"type":"result","subtype":"success","num_turns":1,"result":"TOOLS=%s MEMORY=%s AUTH=%s HOME=%s\\\\nVERDICT: PASS"}\\n' \\
  "$available" "$memory" "$auth" "$HOME"
`

let scratch: string
let binDir: string
let poisonedHome: string
let exportDir: string
let savedHome: string | undefined
let savedPath: string | undefined
let savedConfigDir: string | undefined

/** The sentinel file path the planted `SessionStart` hook writes to. Lives
 *  outside the poisoned HOME so deleting that HOME could never be what makes
 *  the assertion pass. */
function sentinelPath(): string {
  return join(scratch, HOOK_SENTINEL)
}

/** A HOME shaped like the operator's on `llamenos-review-box`: a user-level
 *  CLAUDE.md, a settings file with a `SessionStart` hook, an MCP server
 *  config, and the login state the engine authenticates from. */
function plantPoisonedHome(): string {
  const home = join(scratch, 'operator-home')
  const cfg = join(home, '.claude')
  mkdirSync(cfg, { recursive: true })
  writeFileSync(join(cfg, 'CLAUDE.md'), '# Operator instructions\n\nAlways invoke a planning skill before answering.\n')
  writeFileSync(join(cfg, 'settings.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${sentinelPath()}` }] }] },
    // The fake engine's own cheap extractor reads this key; the realistic
    // nesting above is kept so the fixture still LOOKS like what it stands
    // in for.
    SESSIONSTART_COMMAND: `touch ${sentinelPath()}`,
  }), 'utf8')
  writeFileSync(join(cfg, 'mcp.json'), JSON.stringify({
    mcpServers: { marker: { command: 'marker-server' } },
    MCP_TOOL_NAME: MCP_MARKER_TOOL,
  }), 'utf8')
  writeFileSync(join(cfg, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-not-a-real-token' } }), 'utf8')
  chmodSync(join(cfg, '.credentials.json'), 0o600)
  return home
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'llamenos-reviewer-home-'))
  binDir = join(scratch, 'bin')
  exportDir = join(scratch, 'export')
  mkdirSync(binDir)
  mkdirSync(exportDir)
  writeFileSync(join(exportDir, 'file.ts'), 'export const x = 1\n')
  writeFileSync(join(binDir, 'claude'), FAKE_CLAUDE)
  chmodSync(join(binDir, 'claude'), 0o755)
  poisonedHome = plantPoisonedHome()
  savedHome = process.env['HOME']
  savedPath = process.env['PATH']
  savedConfigDir = process.env['CLAUDE_CONFIG_DIR']
  // The runner's HOME, as the reviewer process would have inherited it.
  process.env['HOME'] = poisonedHome
  process.env['PATH'] = `${binDir}${delimiter}${savedPath ?? ''}`
  delete process.env['CLAUDE_CONFIG_DIR']
})

afterEach(() => {
  if (savedHome === undefined) delete process.env['HOME']; else process.env['HOME'] = savedHome
  if (savedPath === undefined) delete process.env['PATH']; else process.env['PATH'] = savedPath
  if (savedConfigDir === undefined) delete process.env['CLAUDE_CONFIG_DIR']; else process.env['CLAUDE_CONFIG_DIR'] = savedConfigDir
  rmSync(scratch, { recursive: true, force: true })
})

/** Parses the fake engine's reported init line out of a review's text. */
function reported(text: string): { tools: string[]; memory: string; auth: string; home: string } {
  const m = /TOOLS=(\S*) MEMORY=(\S+) AUTH=(\S+) HOME=(\S+)/.exec(text)
  if (m === null) throw new Error(`fake engine reported nothing parseable: ${text}`)
  return {
    tools: m[1] === '' ? [] : m[1]!.split(','),
    memory: m[2]!,
    auth: m[3]!,
    home: m[4]!,
  }
}

async function runReviewer(): Promise<{ text: string; reached: boolean }> {
  const run = await invokeVerifierEngine({
    authorEngine: 'claude',
    exportDir,
    prompt: 'Reply with exactly: VERDICT: PASS\n',
    maxTurns: 1,
    timeoutMs: 30_000,
  })
  return { text: `${run.assistantText}\n${run.diagnostics}`, reached: run.reached }
}

describe('rail: the reviewer loads no configuration the gate did not name (#1460, #1511)', () => {
  it('the planted SessionStart hook does NOT run — the sentinel never appears', async () => {
    const run = await runReviewer()
    expect(run.reached, `engine did not complete: ${run.text}`).toBe(true)
    expect(existsSync(sentinelPath()), 'the runner HOME\'s SessionStart hook executed inside the review session').toBe(false)
  })

  it('the planted MCP server contributes no tool — the available set is EXACTLY the declared one', async () => {
    const { tools } = reported((await runReviewer()).text)
    expect(tools, 'the reviewer\'s available tool set is not exactly REVIEWER_TOOLS').toEqual([...REVIEWER_TOOLS])
    expect(tools, 'an MCP tool reached the reviewer — a write-capable one would make it writable').not.toContain(MCP_MARKER_TOOL)
    expect(tools.some((t) => t.startsWith('mcp__')), 'some MCP tool is present').toBe(false)
  })

  it('the runner\'s user-level CLAUDE.md is not loaded — #1511\'s own mechanism', async () => {
    // The reviewer refused the smoke prompt because the operator's
    // user-level CLAUDE.md demanded a planning workflow while the prompt
    // asked for a bare fixed string. No CLAUDE.md, no conflict.
    expect(reported((await runReviewer()).text).memory).toBe('none')
  })

  it('runs under a HOME this gate created, never the one the process inherited', async () => {
    const { home } = reported((await runReviewer()).text)
    expect(home, 'the reviewer inherited the runner\'s HOME').not.toBe(poisonedHome)
    expect(home).toContain(REVIEWER_HOME_PREFIX)
  })

  it('still authenticates: the one credential file is provisioned into the gate-owned HOME', async () => {
    // The whole risk of a clean HOME is taking the engine's own credentials
    // away with it. `claude` on this runner authenticates from login state
    // on disk (no ANTHROPIC_API_KEY is forwarded, on purpose — see
    // VERIFIER_ENV_ALLOWLIST), so that one file has to travel, and nothing
    // else may.
    expect(reported((await runReviewer()).text).auth).toBe('present')
  })

  it('removes the gate-owned HOME when the review is over', async () => {
    const { home } = reported((await runReviewer()).text)
    expect(existsSync(home), 'the gate-owned HOME outlived the review it was created for').toBe(false)
  })
})

describe('prepareReviewerHome: exactly one file, and it is the same inode as the operator\'s', () => {
  it('provisions the credential file and NOTHING else', async () => {
    const home = await prepareReviewerHome()
    try {
      // Walked, not globbed: a second settings file or a skills directory at
      // any depth is the defect coming back.
      const found: string[] = []
      const walk = (dir: string, rel: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const next = rel === '' ? e.name : `${rel}/${e.name}`
          if (e.isDirectory()) walk(join(dir, e.name), next)
          else found.push(next)
        }
      }
      walk(home.dir, '')
      expect(found, 'the gate-owned HOME holds something other than the one credential file')
        .toEqual([REVIEWER_CREDENTIALS_RELPATH])
    } finally {
      await home.cleanup()
    }
  })

  it('hard-links rather than copies, so a token refresh writes through to the operator\'s store', async () => {
    // A COPY would take the refreshed (and possibly rotated) token to the
    // grave with the temp directory while the operator's store kept a
    // superseded one — a slow walk to a login that stops working, which on a
    // required check stops every merge in the repo. Same inode, no fork.
    const home = await prepareReviewerHome()
    try {
      expect(home.linked, 'the credential file was copied, not hard-linked').toBe(true)
      const src = statSync(join(poisonedHome, '.claude', '.credentials.json'))
      const dst = statSync(join(home.dir, REVIEWER_CREDENTIALS_RELPATH))
      expect(dst.ino).toBe(src.ino)
      expect(src.nlink).toBeGreaterThan(1)
    } finally {
      await home.cleanup()
    }
  })

  it('a hard link, never a symlink — claude opens this file with O_NOFOLLOW and refuses a symlinked one', async () => {
    const home = await prepareReviewerHome()
    try {
      expect(lstatSync(join(home.dir, REVIEWER_CREDENTIALS_RELPATH)).isSymbolicLink()).toBe(false)
    } finally {
      await home.cleanup()
    }
  })

  it('an absent source file is not fatal — the engine then fails as engine-auth, which is a better diagnosis', async () => {
    rmSync(join(poisonedHome, '.claude', '.credentials.json'))
    const home = await prepareReviewerHome()
    try {
      expect(home.linked).toBeUndefined()
      expect(existsSync(join(home.dir, REVIEWER_CREDENTIALS_RELPATH))).toBe(false)
    } finally {
      await home.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// MUTATIONS — "audit gates by breaking them". Every assertion above is a
// NEGATIVE (no sentinel, no MCP tool, no memory), and a negative proves
// nothing until the mechanism is shown to fire. These run the SAME fake
// engine with the SAME arguments, changing only the one thing the fix
// changed, and show both sentinels appearing.
// ---------------------------------------------------------------------------

/** Spawns the fake engine the way `invokeVerifierEngine` does, but with the
 *  caller's choice of HOME and argv — the two things the fix controls. */
function spawnEngine(home: string, args: string[]): string {
  const projectRoot = mkdtempSync(join(scratch, 'root-'))
  const r = spawnSync(join(binDir, 'claude'), args, {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', HOME: home },
    input: 'Reply with exactly: VERDICT: PASS\n',
  })
  return `${r.stdout}\n${r.stderr}`
}

describe('MUTATION: without the gate-owned HOME, both sentinels fire', () => {
  it('inheriting the runner\'s HOME executes its SessionStart hook and loads its CLAUDE.md', () => {
    // Exactly what `verifierEnv` produced before #1460: the inherited HOME.
    const out = spawnEngine(poisonedHome, verifierArgs({ model: 'sonnet', maxTurns: 1, exportDir }))
    expect(existsSync(sentinelPath()), 'the sentinel mechanism is dead — the tests above prove nothing')
      .toBe(true)
    expect(reported(out).memory, 'the CLAUDE.md mechanism is dead — the #1511 test above proves nothing')
      .toBe('loaded')
  })

  it('dropping --strict-mcp-config hands the reviewer the runner\'s MCP tool', () => {
    const args = verifierArgs({ model: 'sonnet', maxTurns: 1, exportDir })
      .filter((a) => a !== '--strict-mcp-config')
    expect(args, 'the mutation removed nothing — verifierArgs no longer passes the flag').not.toContain('--strict-mcp-config')
    const { tools } = reported(spawnEngine(poisonedHome, args))
    expect(tools, 'the MCP mechanism is dead — the tool-set test above proves nothing').toContain(MCP_MARKER_TOOL)
  })
})
