// deploy/ansible/scripts/run-ci-guards.py (#2645): the single ci.yml step that
// runs every guard registered under deploy/ansible/ci-guards/.
//
// What this proves is that the runner cannot go green vacuously and cannot
// hide WHICH guard tripped -- the two properties the old one-step-per-guard
// list had for free and a naive "run all guards" loop would lose.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '../../..')
const RUNNER = join(REPO, 'deploy/ansible/scripts/run-ci-guards.py')
const REAL_DIR = join(REPO, 'deploy/ansible/ci-guards')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ci-guards-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function guard(id: string, body: string) {
  writeFileSync(join(dir, `${id}.toml`), body)
}

function run(...args: string[]) {
  const p = Bun.spawnSync(['python3', '-I', RUNNER, '--dir', dir, ...args], { cwd: REPO })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

describe('run-ci-guards', () => {
  test('runs every guard and exits 0 when all pass', () => {
    guard('a', 'name = "Guard A"\nrun = "echo ran-a"\n')
    guard('b', 'name = "Guard B"\nrun = "echo ran-b"\n')
    const r = run('--min', '2')
    expect(r.code).toBe(0)
    expect(r.out).toContain('ran-a')
    expect(r.out).toContain('ran-b')
    expect(r.out).toContain('::group::Guard A')
  })

  test('a failing guard fails the run, is named, and does not stop the others', () => {
    guard('a', 'name = "Guard A"\nrun = "echo ran-a"\n')
    guard('b', 'name = "Guard B"\nrun = "exit 3"\n')
    guard('c', 'name = "Guard C"\nrun = "echo ran-c"\n')
    const r = run('--min', '3')
    expect(r.code).toBe(1)
    expect(r.out).toContain('::error title=ansible guard failed::Guard B (exit 3)')
    expect(r.out).toContain('ran-c') // C ran AFTER B failed
    expect(r.err).toContain('x Guard B')
    expect(r.err).not.toContain('x Guard A')
    expect(r.err).not.toContain('x Guard C')
  })

  test('multi-line run bodies are executed by bash with the repo root as cwd', () => {
    guard('a', "name = \"Guard A\"\nrun = '''\nset -e\ntest -f deploy/ansible/ci-guards/required-env.toml\n'''\n")
    expect(run('--min', '1').code).toBe(0)
  })

  test('an empty directory is an error, never a pass', () => {
    const r = run('--min', '1')
    expect(r.code).toBe(2)
    expect(r.err).toContain('Found only 0 guard(s)')
  })

  test('fewer guards than the floor is an error', () => {
    guard('a', 'name = "Guard A"\nrun = "true"\n')
    expect(run('--min', '2').code).toBe(2)
  })

  test('a missing directory is an error', () => {
    rmSync(dir, { recursive: true, force: true })
    expect(run('--min', '1').code).toBe(2)
  })

  test.each([
    ['missing run', 'name = "X"\n'],
    ['blank name', 'name = " "\nrun = "true"\n'],
    ['unknown key', 'name = "X"\nrun = "true"\nrunn = "true"\n'],
    ['invalid TOML', 'name = \n'],
  ])('rejects a malformed manifest: %s', (_label, body) => {
    guard('bad', body)
    const r = run('--min', '1')
    expect(r.code).toBe(2)
    expect(r.err).toContain('bad.toml')
  })

  test('rejects two guards with the same name', () => {
    guard('a', 'name = "Same"\nrun = "true"\n')
    guard('b', 'name = "Same"\nrun = "true"\n')
    const r = run('--min', '1')
    expect(r.code).toBe(2)
    expect(r.err).toContain('duplicate name')
  })
})

describe('the real manifest', () => {
  test('parses and every guard script it names exists', () => {
    const files = readdirSync(REAL_DIR).filter((f) => f.endsWith('.toml'))
    expect(files.length).toBeGreaterThanOrEqual(8)
    const p = Bun.spawnSync(
      [
        'python3',
        '-I',
        '-c',
        'import sys,json,importlib.util as u;s=u.spec_from_file_location("r",sys.argv[1]);m=u.module_from_spec(s);s.loader.exec_module(m);from pathlib import Path;print(json.dumps(m.load_guards(Path(sys.argv[2]))))',
        RUNNER,
        REAL_DIR,
      ],
      { cwd: REPO },
    )
    expect(p.exitCode).toBe(0)
    const guards = JSON.parse(p.stdout.toString()) as { name: string; run: string }[]
    expect(guards.length).toBe(files.length)
    for (const g of guards) {
      for (const m of g.run.matchAll(/(?:python3 |^)((?:deploy|scripts)\/[\w./-]+\.(?:py|sh))/gm)) {
        expect(Bun.file(join(REPO, m[1])).size).toBeGreaterThan(0)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Exhaustiveness (#2645). The old ci.yml list could silently lose a guard (a
// script added without a step); a directory manifest has the same hole one
// level down: a guard file that no manifest entry runs. Nothing else notices,
// because an unrun guard is green. This walks the tree for guard files and
// fails for any that nothing executes.
// ---------------------------------------------------------------------------

const ANSIBLE = join(REPO, 'deploy/ansible')
const GUARD_NAME = /^check[-_].+\.(py|yml|sh)$/

// Guards that are deliberately NOT run by ci-guards/. Each needs something the
// ansible-validate job does not have, and says so in its own header. This is a
// list of what is knowingly out of CI -- an unlisted file fails below, so a new
// guard can never land in this state by accident. Do not add to it to make the
// test pass; register the guard in ci-guards/ instead.
const RUN_BY_HAND: Record<string, string> = {
  'deploy/ansible/scripts/check-disk-tier-guards.py': 'builds a two-host layout and needs Docker for its Caddy cases',
  'deploy/ansible/scripts/check-smoke-verdicts.py': 'runs the smoke suite in a private network namespace with real sockets',
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '__pycache__' || entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

/** Guard files that exist on disk but are executed by neither a manifest entry nor another executed guard. */
function unexecutedGuards(ansibleDir: string, manifestDir: string, byHand: readonly string[]): string[] {
  const all = walk(ansibleDir)
  const candidates = all.filter((f) => GUARD_NAME.test(basename(f)))
  const manifestText = readdirSync(manifestDir)
    .filter((f) => f.endsWith('.toml'))
    .map((f) => readFileSync(join(manifestDir, f), 'utf8'))
    .join('\n')
  // A guard reached from an executed guard (a playbook a script drives, a task
  // file a playbook includes) counts as executed: the closure is by file name.
  const executed = new Set<string>()
  const queue: string[] = []
  for (const f of candidates) {
    if (manifestText.includes(basename(f))) {
      executed.add(f)
      queue.push(f)
    }
  }
  while (queue.length) {
    const text = readFileSync(queue.pop() as string, 'utf8')
    for (const f of candidates) {
      if (!executed.has(f) && text.includes(basename(f))) {
        executed.add(f)
        queue.push(f)
      }
    }
  }
  return candidates
    .filter((f) => !executed.has(f))
    .map((f) => relative(REPO, f))
    .filter((f) => !byHand.includes(f))
}

describe('every guard on disk is executed', () => {
  test('no check-* guard under deploy/ansible/ is left unrun', () => {
    expect(unexecutedGuards(ANSIBLE, REAL_DIR, Object.keys(RUN_BY_HAND))).toEqual([])
  })

  test('every run-by-hand exemption still names a real file (no stale exemptions)', () => {
    for (const f of Object.keys(RUN_BY_HAND)) expect(statSync(join(REPO, f)).isFile()).toBe(true)
  })

  test('ci-guards/ holds only manifests: a mis-named file would be skipped by the *.toml glob', () => {
    const stray = readdirSync(REAL_DIR).filter((f) => !f.endsWith('.toml') && f !== 'README.md')
    expect(stray).toEqual([])
  })

  test('the detector itself fires: a guard on disk with no manifest entry is reported', () => {
    const fake = mkdtempSync(join(tmpdir(), 'ansible-tree-'))
    try {
      const manifest = join(fake, 'ci-guards')
      Bun.spawnSync(['mkdir', '-p', manifest, join(fake, 'scripts')])
      writeFileSync(join(fake, 'scripts/check-wired.py'), '')
      writeFileSync(join(fake, 'scripts/check-orphan.py'), '')
      writeFileSync(join(manifest, 'wired.toml'), 'name = "w"\nrun = "python3 deploy/ansible/scripts/check-wired.py"\n')
      expect(unexecutedGuards(fake, manifest, []).map((f) => basename(f))).toEqual(['check-orphan.py'])
    } finally {
      rmSync(fake, { recursive: true, force: true })
    }
  })
})
