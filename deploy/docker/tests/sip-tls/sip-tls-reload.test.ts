/**
 * deploy/docker/sip-tls-reload.sh — the piece that makes an ACME certificate
 * on the SIP edge safe to use.
 *
 * Kamailio and Asterisk each parse their certificate ONCE, at module init. A
 * Let's Encrypt renewal (Caddy, ~60 days) is therefore invisible to the running
 * process: without this script a deployment serves an expired certificate two
 * months after it was set up, while the file on disk is valid and no log says
 * anything is wrong. Clients verify the chain, so they fail CLOSED and no
 * volunteer receives a call.
 *
 * Tested with a stub `docker` on PATH that records its arguments, so the real
 * script's decision logic runs without a container runtime.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const SCRIPT = path.resolve(__dirname, '../../sip-tls-reload.sh')
const hasOpenssl = spawnSync('openssl', ['version']).status === 0

let dir: string
let binDir: string
let callLog: string
let stampFile: string

/**
 * A stub `docker` that logs its argv. `compose ps -q <svc>` prints a fake
 * container id so the script believes the service is up; every other
 * subcommand succeeds silently.
 */
function installDockerStub({ failReload = false }: { failReload?: boolean } = {}) {
  const stub = path.join(binDir, 'docker')
  writeFileSync(
    stub,
    `#!/bin/sh
echo "$*" >> "${callLog}"
for a in "$@"; do
  if [ "$a" = "ps" ]; then echo "stub-container-id"; exit 0; fi
done
case "$*" in
  *exec*) exit ${failReload ? 1 : 0} ;;
esac
exit 0
`,
  )
  chmodSync(stub, 0o755)
}

function makeCert(target: string, cn: string) {
  mkdirSync(path.dirname(target), { recursive: true })
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(dir, 'throwaway.key'), '-out', target,
    '-days', '2', '-subj', `/CN=${cn}`, '-addext', `subjectAltName=DNS:${cn}`,
  ], { stdio: 'ignore' })
}

function run(watchFile: string): { stderr: string; status: number } {
  const res = spawnSync('/bin/sh', [SCRIPT, dir], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      SIP_TLS_WATCH_FILE: watchFile,
      SIP_TLS_STAMP_FILE: stampFile,
    },
    encoding: 'utf8',
  })
  return { stderr: res.stderr ?? '', status: res.status ?? -1 }
}

const calls = () => (existsSync(callLog) ? readFileSync(callLog, 'utf8') : '')

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sip-reload-'))
  binDir = path.join(dir, 'bin')
  mkdirSync(binDir, { recursive: true })
  callLog = path.join(dir, 'docker-calls.log')
  stampFile = path.join(dir, 'reload.stamp')
  installDockerStub()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!hasOpenssl)('sip-tls-reload.sh', () => {
  it('reloads both services the first time it sees a certificate', () => {
    const cert = path.join(dir, 'tls', 'example.org.crt')
    makeCert(cert, 'example.org')

    const { status } = run(cert)

    expect(status).toBe(0)
    // Kamailio's TLS module reload, and Asterisk's transport rebuild.
    expect(calls()).toContain('kamcmd tls.reload')
    expect(calls()).toContain('module reload res_pjsip.so')
  })

  it('does NOTHING on a second run when the certificate has not changed', () => {
    // It is meant to sit on a short timer, so an unchanged certificate must
    // not churn the SIP edge every tick.
    const cert = path.join(dir, 'tls', 'example.org.crt')
    makeCert(cert, 'example.org')
    run(cert)
    rmSync(callLog, { force: true })

    const { status } = run(cert)

    expect(status).toBe(0)
    expect(calls()).not.toContain('tls.reload')
    expect(calls()).not.toContain('res_pjsip')
  })

  it('reloads again once the certificate actually changes (the renewal)', () => {
    const cert = path.join(dir, 'tls', 'example.org.crt')
    makeCert(cert, 'example.org')
    run(cert)
    rmSync(callLog, { force: true })

    // What Caddy does at ~60 days: same path, new content.
    makeCert(cert, 'example.org')
    const { status } = run(cert)

    expect(status).toBe(0)
    expect(calls()).toContain('kamcmd tls.reload')
    expect(calls()).toContain('module reload res_pjsip.so')
  })

  it('does not record success when a reload fails, so the next tick retries', () => {
    // Recording a failed reload as done would leave the edge serving an
    // expired certificate until the following renewal — the exact failure the
    // script exists to prevent.
    const cert = path.join(dir, 'tls', 'example.org.crt')
    makeCert(cert, 'example.org')
    installDockerStub({ failReload: true })

    const first = run(cert)
    expect(first.status).not.toBe(0)
    expect(first.stderr).toContain('FAILED')
    expect(existsSync(stampFile)).toBe(false)

    // Now the reload works: it must try again rather than skip.
    installDockerStub()
    rmSync(callLog, { force: true })
    const second = run(cert)
    expect(second.status).toBe(0)
    expect(calls()).toContain('kamcmd tls.reload')
  })

  it('exits cleanly when no certificate is configured', () => {
    // The self-signed default needs no reload, and the timer must not fail.
    const res = spawnSync('/bin/sh', [SCRIPT, dir], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, SIP_TLS_STAMP_FILE: stampFile },
      encoding: 'utf8',
    })
    expect(res.status).toBe(0)
    expect(res.stderr).toContain('no certificate to watch')
    expect(calls()).toBe('')
  })

  it('exits cleanly when the certificate does not exist yet', () => {
    // First boot, before ACME issuance has completed.
    const { status, stderr } = run(path.join(dir, 'tls', 'not-yet.crt'))
    expect(status).toBe(0)
    expect(stderr).toContain('missing or empty')
    expect(calls()).toBe('')
  })

  it('never writes private key material into the stamp file', () => {
    // The stamp is world-readable and may be echoed into a journal.
    const cert = path.join(dir, 'tls', 'example.org.crt')
    makeCert(cert, 'example.org')
    run(cert)

    const stamp = readFileSync(stampFile, 'utf8')
    expect(stamp).not.toContain('PRIVATE KEY')
    expect(stamp).not.toContain('BEGIN')
    // Just a hex digest of the public certificate.
    expect(stamp.trim()).toMatch(/^[0-9a-f]{64}$/)
  })
})
