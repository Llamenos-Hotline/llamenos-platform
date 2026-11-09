// The `Run gitleaks` step of .github/workflows/secret-scan.yml, executed for
// real against a local server standing in for the release host.
//
// The script is read out of the workflow, so these tests cannot drift from what
// CI runs. Only the release host and the /tmp prefix are rewritten; curl,
// sha256sum and tar are the real binaries, so a 504 here exercises curl's
// actual retry flags. The `gitleaks` inside the fixture tarball is a stub.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WORKFLOW = join(import.meta.dir, '..', '..', '.github', 'workflows', 'secret-scan.yml')
const RELEASE_HOST = 'https://github.com/gitleaks/gitleaks/releases/download'
const WORKFLOW_TMP = '/tmp/gitleaks'

interface Step {
  name?: string
  run?: string
}

function workflowScript(): string {
  const doc = Bun.YAML.parse(readFileSync(WORKFLOW, 'utf8')) as { jobs: { gitleaks: { steps: Step[] } } }
  const script = doc.jobs.gitleaks.steps.find((s) => s.name === 'Run gitleaks')?.run
  if (!script) throw new Error('secret-scan.yml has no `Run gitleaks` step')
  // Without these the rewrites below would silently leave the test pointing at
  // the real release host and the shared /tmp.
  expect(script).toContain(RELEASE_HOST)
  expect(script).toContain(WORKFLOW_TMP)
  return script
}

function sh(cmd: string[], cwd: string): string {
  const r = Bun.spawnSync(cmd, { cwd })
  if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString()
}

let work: string
let tarball: Uint8Array<ArrayBuffer>
let sha256: string
let server: ReturnType<typeof Bun.serve>
let requests: number
let respond: (attempt: number) => Response

const scannerRan = () => existsSync(join(work, 'scanner-ran'))
const cachedTarball = () => join(work, 'gitleaks.tar.gz')
const gatewayTimeout = () => new Response('gateway timeout', { status: 504 })
const servesTarball = () => new Response(tarball)

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'secret-scan-download-'))

  const fixture = join(work, 'fixture')
  mkdirSync(fixture)
  writeFileSync(
    join(fixture, 'gitleaks'),
    `#!/usr/bin/env bash\n[ "$1" = version ] && exit 0\ntouch "${join(work, 'scanner-ran')}"\nexit "\${STUB_SCAN_EXIT:-0}"\n`,
  )
  chmodSync(join(fixture, 'gitleaks'), 0o755)
  sh(['tar', '-czf', 'fixture.tar.gz', 'gitleaks'], fixture)
  tarball = new Uint8Array(readFileSync(join(fixture, 'fixture.tar.gz')))
  sha256 = new Bun.CryptoHasher('sha256').update(tarball).digest('hex')

  // A range check is not under test here; report one commit to scan.
  const bin = join(work, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'git'), '#!/usr/bin/env bash\necho 1\n')
  chmodSync(join(bin, 'git'), 0o755)

  requests = 0
  respond = gatewayTimeout
  server = Bun.serve({
    port: 0,
    fetch() {
      requests += 1
      return respond(requests)
    },
  })
})

afterEach(() => {
  server.stop(true)
  rmSync(work, { recursive: true, force: true })
})

// Bun.spawn, not spawnSync: the server shares this event loop, so a synchronous
// child would wait forever on a response the server could never send.
async function runStep(env: Record<string, string> = {}) {
  const script = workflowScript()
    .replaceAll(RELEASE_HOST, `http://127.0.0.1:${server.port}`)
    .replaceAll(WORKFLOW_TMP, join(work, 'gitleaks'))
    // The workflow's `-C /tmp` extraction target, which the prefix above misses.
    .replaceAll('-C /tmp ', `-C ${work} `)
  const proc = Bun.spawn(['bash', '-e', '-c', script], {
    cwd: work,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PATH: `${join(work, 'bin')}:${process.env.PATH}`,
      GITHUB_EVENT_NAME: 'pull_request',
      PR_BASE: 'base',
      PR_HEAD: 'head',
      GITLEAKS_VERSION: '8.30.1',
      GITLEAKS_SHA256: sha256,
      ...env,
    },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, output: stdout + stderr }
}

describe('Run gitleaks: obtaining the scanner', () => {
  test('a cached, verified tarball scans through a release-host outage without touching the network', async () => {
    writeFileSync(cachedTarball(), tarball)

    const { exitCode, output } = await runStep()

    expect(output).toContain('Using the cached gitleaks')
    expect(requests).toBe(0)
    expect(scannerRan()).toBe(true)
    expect(exitCode).toBe(0)
  })

  test('a cold cache rides out transient 504s and says it is retrying', async () => {
    respond = (attempt) => (attempt <= 2 ? gatewayTimeout() : servesTarball())

    const { exitCode, output } = await runStep()

    expect(requests).toBe(3)
    expect(output).toContain('Will retry')
    expect(scannerRan()).toBe(true)
    expect(exitCode).toBe(0)
  }, 30_000)

  test('a corrupt cache entry is discarded loudly and replaced, so it cannot wedge the check', async () => {
    writeFileSync(cachedTarball(), 'not the tarball we pinned')
    respond = servesTarball

    const { exitCode, output } = await runStep()

    expect(output).toContain('::warning::discarding a cached gitleaks tarball')
    expect(requests).toBe(1)
    expect(scannerRan()).toBe(true)
    expect(exitCode).toBe(0)
  })

  test('a download that never recovers fails closed and names the scan as not having run', async () => {
    const { exitCode, output } = await runStep()

    expect(requests).toBe(5)
    expect(output).toContain('::error::could not download the gitleaks 8.30.1 binary')
    expect(output).toContain('DID NOT RUN')
    expect(scannerRan()).toBe(false)
    expect(exitCode).not.toBe(0)
  }, 60_000)

  test('a downloaded tarball with the wrong checksum is refused and never executed', async () => {
    respond = () => new Response('a tampered release asset')

    const { exitCode, output } = await runStep()

    expect(output).toContain('does not match GITLEAKS_SHA256')
    expect(scannerRan()).toBe(false)
    expect(exitCode).not.toBe(0)
  })

  test("the scanner's own failure still fails the step when it came from the cache", async () => {
    writeFileSync(cachedTarball(), tarball)

    const { exitCode } = await runStep({ STUB_SCAN_EXIT: '1' })

    expect(scannerRan()).toBe(true)
    expect(exitCode).toBe(1)
  })
})
