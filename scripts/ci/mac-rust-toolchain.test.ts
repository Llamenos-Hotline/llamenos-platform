// @suite: repo
// Break-it suite for #3115: two iOS jobs on the Mac shared ONE asdf-managed rustup
// home, so a second `rustup target add` lost a rename race and failed "Install Rust
// stable" on a PR with nothing wrong in it.
//
// The race itself needs two real toolchain installs, so it was reproduced by hand
// against a scratch home (job1 `could not rename 'downloaded' file ... rolling back
// changes`, job2 ok). What CI can pin, and what this file pins, is the two things
// that make the isolation hold or not:
//   - `setup` gives each runner its own, different homes under one root and writes
//     nothing outside it, and refuses to run without a runner name;
//   - `verify` goes RED when the isolation did not hold (the asdf home, a shim
//     rustc, a missing target) - the control that proves the gate can still fail;
//   - no Mac job installs Rust through the shared path any more.
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

const ROOT = resolve(import.meta.dir, '../..')
const SCRIPT = join(ROOT, 'scripts/ci/mac-rust-toolchain.sh')

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'mac-rust-'))
  return { dir, root: join(dir, 'ci-rust'), env: join(dir, 'github_env'), path: join(dir, 'github_path') }
}

/** A stand-in rustup/rustc pair. `home` is what `rustup show home` reports. */
function fakeToolchain(bin: string, home: string, installed: string[]) {
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, 'rustup'),
    `#!/bin/sh
case "$1 $2" in
  "show home") echo "${home}" ;;
  "target list") printf '%s\\n' ${installed.map((t) => `"${t}"`).join(' ')} ;;
esac
`,
  )
  writeFileSync(join(bin, 'rustc'), '#!/bin/sh\necho "rustc 0.0.0 (fake)"\n')
  chmodSync(join(bin, 'rustup'), 0o755)
  chmodSync(join(bin, 'rustc'), 0o755)
}

function run(args: string[], env: Record<string, string>) {
  return spawnSync('bash', [SCRIPT, ...args], {
    env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent-home', ...env },
    encoding: 'utf8',
  })
}

describe('setup', () => {
  test('each runner gets its own homes, exported and put on PATH, with nothing written elsewhere', () => {
    const sb = sandbox()
    const out: Record<string, { env: string; path: string }> = {}
    for (const name of ['mac-mini-ios-1', 'mac-mini-ios-2']) {
      // A warm host: rustup already bootstrapped, so no network is needed.
      const home = join(sb.root, name)
      fakeToolchain(join(home, 'cargo', 'bin'), join(home, 'rustup'), [])
      const env = join(sb.dir, `${name}.env`)
      const path = join(sb.dir, `${name}.path`)
      writeFileSync(env, '')
      writeFileSync(path, '')
      const r = run(['setup'], { RUNNER_NAME: name, MAC_RUST_ROOT: sb.root, GITHUB_ENV: env, GITHUB_PATH: path })
      expect(r.status, r.stderr).toBe(0)
      out[name] = { env: readFileSync(env, 'utf8'), path: readFileSync(path, 'utf8') }
    }
    const a = out['mac-mini-ios-1']
    const b = out['mac-mini-ios-2']
    expect(a.env).toContain(`RUSTUP_HOME=${sb.root}/mac-mini-ios-1/rustup`)
    expect(a.env).toContain(`CARGO_HOME=${sb.root}/mac-mini-ios-1/cargo`)
    expect(b.env).toContain(`RUSTUP_HOME=${sb.root}/mac-mini-ios-2/rustup`)
    expect(a.path.trim()).toBe(`${sb.root}/mac-mini-ios-1/cargo/bin`)
    // the whole point: the two runners can never name the same directory
    expect(a.env).not.toEqual(b.env)
    // and nothing else appeared next to them
    expect(readdirSync(sb.root).sort()).toEqual(['mac-mini-ios-1', 'mac-mini-ios-2'])
    expect(a.env).not.toContain('.asdf')
  })

  test('refuses to run without a runner name instead of falling back to a shared directory', () => {
    const sb = sandbox()
    const r = run(['setup'], { MAC_RUST_ROOT: sb.root })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('RUNNER_NAME is empty')
    expect(existsSync(sb.root)).toBe(false)
  })

  test('a runner name cannot escape the root', () => {
    const sb = sandbox()
    const name = '../../escape'
    const home = join(sb.root, '.._.._escape')
    fakeToolchain(join(home, 'cargo', 'bin'), join(home, 'rustup'), [])
    const r = run(['setup'], { RUNNER_NAME: name, MAC_RUST_ROOT: sb.root })
    expect(r.status, r.stderr).toBe(0)
    expect(existsSync(join(sb.dir, 'escape'))).toBe(false)
  })
})

describe('verify', () => {
  const targets = 'aarch64-apple-ios,aarch64-apple-ios-sim'
  function verify(opts: { reportedHome?: string; rustcDir?: 'own' | 'shim'; installed?: string[] }) {
    const sb = sandbox()
    const own = join(sb.root, 'mac-mini-ios-1')
    const ownBin = join(own, 'cargo', 'bin')
    fakeToolchain(ownBin, opts.reportedHome ?? join(own, 'rustup'), opts.installed ?? targets.split(','))
    let pathDirs = ownBin
    if (opts.rustcDir === 'shim') {
      // an asdf-shim-like dir ahead of the runner's own bin
      const shim = join(sb.dir, 'asdf-shims')
      fakeToolchain(shim, join(own, 'rustup'), targets.split(','))
      pathDirs = `${shim}:${ownBin}`
    }
    return run(['verify', targets], {
      RUNNER_NAME: 'mac-mini-ios-1',
      MAC_RUST_ROOT: sb.root,
      PATH: `${pathDirs}:/usr/bin:/bin`,
    })
  }

  test('passes when the toolchain is the runner\'s own and both targets are installed', () => {
    const r = verify({})
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('toolchain ok')
  })

  test('FAILS when rustup still points at the shared asdf installation', () => {
    const r = verify({ reportedHome: '/opt/shared-asdf/installs/rust/1.93.1' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('still sharing a toolchain')
  })

  test('FAILS when rustc resolves to a shim ahead of the runner\'s own bin', () => {
    const r = verify({ rustcDir: 'shim' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('shim or a shared install is ahead')
  })

  test('FAILS naming the target when one is missing', () => {
    const r = verify({ installed: ['aarch64-apple-ios'] })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("target 'aarch64-apple-ios-sim' is not installed")
  })
})

describe('no Mac job installs Rust through the shared path', () => {
  const MAC_LABEL = 'ios-e2e'
  const files = ['ci.yml', 'ios-e2e.yml']

  test('every self-hosted Mac job uses the per-runner action, never dtolnay/rust-toolchain', () => {
    let macJobs = 0
    let viaAction = 0
    for (const f of files) {
      const wf = parseYaml(readFileSync(join(ROOT, '.github/workflows', f), 'utf8')) as {
        jobs: Record<string, { 'runs-on'?: unknown; steps?: { uses?: string }[] }>
      }
      for (const [name, job] of Object.entries(wf.jobs)) {
        const labels = Array.isArray(job['runs-on']) ? (job['runs-on'] as string[]) : []
        if (!labels.includes('self-hosted') || !labels.includes(MAC_LABEL)) continue
        macJobs++
        for (const step of job.steps ?? []) {
          expect(step.uses ?? '', `${f}:${name} installs Rust through the shared asdf path`).not.toContain('dtolnay/rust-toolchain')
          if (step.uses === './.github/actions/mac-rust-toolchain') viaAction++
        }
      }
    }
    // ios-build-test, ios-compile-check, and ios-e2e's build job
    expect(macJobs).toBeGreaterThanOrEqual(3)
    expect(viaAction).toBe(3)
  })

  test('the composite action runs setup before the toolchain and verify after it', () => {
    const action = parseYaml(readFileSync(join(ROOT, '.github/actions/mac-rust-toolchain/action.yml'), 'utf8')) as {
      runs: { steps: { run?: string; uses?: string }[] }
    }
    const steps = action.runs.steps
    const setupAt = steps.findIndex((s) => s.run?.includes('mac-rust-toolchain.sh" setup'))
    const installAt = steps.findIndex((s) => s.uses?.startsWith('dtolnay/rust-toolchain@'))
    const verifyAt = steps.findIndex((s) => s.run?.includes('mac-rust-toolchain.sh" verify'))
    expect(setupAt).toBeGreaterThanOrEqual(0)
    expect(installAt).toBeGreaterThan(setupAt)
    expect(verifyAt).toBeGreaterThan(installAt)
  })
})
