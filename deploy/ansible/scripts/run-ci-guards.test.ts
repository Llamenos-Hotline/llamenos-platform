// deploy/ansible/scripts/run-ci-guards.py (#2645): the single ci.yml step that
// runs every guard registered under deploy/ansible/ci-guards/.
//
// What this proves is that the runner cannot go green vacuously and cannot
// hide WHICH guard tripped -- the two properties the old one-step-per-guard
// list had for free and a naive "run all guards" loop would lose.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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
