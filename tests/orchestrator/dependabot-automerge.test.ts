import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/**
 * dependabot-automerge.yml enables auto-merge on exactly one signal: the PR's
 * API-reported author. These tests run the workflow's real `run:` script
 * against a stub `gh` so the gate is exercised, not pattern-matched.
 *
 * The stub answers `pulls/{n}` with a full PR object, but the script's own
 * `--jq '.user.login'` is applied by the stub, so a script that read the title,
 * branch or labels instead would get the wrong answer and the imitation test
 * would catch it.
 */
const WORKFLOW = join(process.cwd(), '.github', 'workflows', 'dependabot-automerge.yml')

const runScript = (): string => {
  const yaml = readFileSync(WORKFLOW, 'utf8')
  const block = yaml.split(/\n {8}run: \|\n/)[1]
  if (block === undefined) throw new Error('workflow has no run: block')
  return block.split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n')
}

// A PR that imitates Dependabot in every author-controlled way.
const IMITATION = {
  title: 'ci: bump actions/download-artifact from 4.3.0 to 8.0.2',
  head: { ref: 'dependabot/github_actions/actions/download-artifact-8.0.2' },
  labels: [{ name: 'dependencies' }, { name: 'ci' }],
  files: ['.github/workflows/ci.yml'],
}

let dir: string
let log: string
let script: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dependabot-automerge-'))
  log = join(dir, 'gh.log')
  script = join(dir, 'run.sh')
  writeFileSync(script, runScript())
  const stub = join(dir, 'bin')
  spawnSync('mkdir', ['-p', stub])
  writeFileSync(join(stub, 'gh'), `#!/usr/bin/env bash
echo "gh $*" >> "${log}"
case "$1 $2" in
  "api repos/o/r/commits/abc123/pulls") echo 7 ;;
  "api repos/o/r/pulls/7")
    # Only the author field may be asked for; anything else is a gate on the wrong signal.
    [ "$3" = "--jq" ] && [ "$4" = ".user.login" ] || { echo "script read something other than .user.login: $*" >&2; exit 9; }
    echo "$FAKE_AUTHOR" ;;
  "pr merge") ;;
  *) echo "unexpected gh call: $*" >&2; exit 9 ;;
esac
`)
  chmodSync(join(stub, 'gh'), 0o755)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const run = (author: string): { status: number | null; calls: string[] } => {
  writeFileSync(log, '')
  const r = spawnSync('bash', [script], {
    env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, REPO: 'o/r', HEAD_SHA: 'abc123', FAKE_AUTHOR: author, IMITATION: JSON.stringify(IMITATION) },
    encoding: 'utf8',
  })
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean)
  return { status: r.status, calls }
}

describe('dependabot-automerge.yml', () => {
  it('a dependabot[bot]-authored PR gets auto-merge enabled, squash, via --auto', () => {
    const { status, calls } = run('dependabot[bot]')
    expect(status).toBe(0)
    expect(calls.filter((c) => c.startsWith('gh pr merge'))).toEqual(['gh pr merge 7 --repo o/r --auto --squash'])
  })

  it('a human PR imitating dependabot (title, branch prefix, label, files) does NOT get auto-merge', () => {
    const { status, calls } = run('mallory')
    expect(status).toBe(0)
    expect(calls.filter((c) => c.includes('pr merge'))).toEqual([])
  })

  it('lookalike logins do not pass the exact-match gate', () => {
    for (const login of ['dependabot', 'dependabot[bot', 'Dependabot[bot]', 'dependabot[bot] ', 'llamenos-auto']) {
      expect(run(login).calls.filter((c) => c.includes('pr merge')), login).toEqual([])
    }
  })

  it('never merges directly, never bypasses: only --auto, no --admin', () => {
    const lines = readFileSync(WORKFLOW, 'utf8').split('\n').filter((l) => !l.trim().startsWith('#'))
    const merges = lines.filter((l) => /gh pr merge/.test(l))
    expect(merges).toHaveLength(1)
    expect(merges[0]).toMatch(/--auto\b/)
    expect(lines.join('\n')).not.toMatch(/--admin|--merge\b|--rebase\b/)
  })

  it('runs from the base branch with the PAT and no ambient token permissions', () => {
    const yaml = readFileSync(WORKFLOW, 'utf8')
    const onBlock = yaml.split(/\njobs:\n/)[0] ?? ''
    expect(onBlock).toContain('workflow_run:')
    expect(onBlock, 'a pull_request(_target) trigger would run the PR\'s own copy or lose the PAT').not.toMatch(/\n {2}pull_request(_target)?:/)
    expect(yaml).toContain('GH_TOKEN: ${{ secrets.RELEASE_BOT_TOKEN }}')
    expect(yaml.match(/\npermissions: \{\}\n/), 'workflow-level permissions must be explicit and empty').toBeTruthy()
    expect(yaml, 'must not check out or run PR code').not.toMatch(/actions\/checkout/)
  })
})
