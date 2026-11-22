import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadWorkflow, getJob, getStep } from './helpers/workflow-shell.js'

/**
 * Rail for #2628: the registry build cache every Docker-building CI job
 * imports must be anonymously pullable, and the producer must say so loudly
 * when it is not.
 *
 * What went wrong. Consumers import `ghcr.io/<repo>:buildcache` with no login
 * (by design). The package was not public, so each import 401'd at the token
 * endpoint, BuildKit logged it and rebuilt from scratch — in 58 of 96 jobs
 * across four green merge groups — while docker-buildcache.yml itself kept
 * succeeding. A cache miss fails nothing, so nothing reported it.
 *
 * What this pins. The producer's last step runs
 * .github/scripts/check-buildcache-public.sh, which does what a consumer
 * does (anonymous token, then manifest) and exits non-zero on any refusal.
 * The cases below run the REAL script against a stubbed `curl`, so a grep for
 * the right words cannot pass it: only behaviour does. Each failure mode is a
 * distinct refusal, so a script that only checked one of them would fail here.
 */

const SCRIPT = join(process.cwd(), '.github', 'scripts', 'check-buildcache-public.sh')
const IMAGE = 'ghcr.io/llamenos-hotline/llamenos-platform'

/**
 * A `curl` that answers the two requests the script makes. `tokenStatus` /
 * `manifestStatus` are the HTTP codes it reports; the token body is a real
 * token shape on 200 and the registry's refusal body otherwise.
 */
function run(opts: { tokenStatus: number; manifestStatus?: number; tokenBody?: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'buildcache-curl-'))
  const log = join(dir, 'calls.log')
  const body = opts.tokenBody ?? (opts.tokenStatus === 200 ? '{"token":"anon-token"}' : '{"errors":[{"code":"DENIED"}]}')
  writeFileSync(
    join(dir, 'curl'),
    `#!/usr/bin/env bash
echo "$*" >> '${log}'
case "$*" in
  *"/token?"*) printf '%s\\n%s' '${body}' '${opts.tokenStatus}' ;;
  *"/manifests/"*) printf '%s' '${opts.manifestStatus ?? 200}' ;;
  *) echo "unexpected curl: $*" >&2; exit 99 ;;
esac
`,
  )
  chmodSync(join(dir, 'curl'), 0o755)
  const r = spawnSync('bash', [SCRIPT, IMAGE, 'buildcache'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  })
  const calls = existsSync(log) ? readFileSync(log, 'utf8') : ''
  return { ...r, out: `${r.stdout}${r.stderr}`, calls }
}

describe('rail: the build cache is anonymously pullable', () => {
  it('passes when the token and the manifest are both readable', () => {
    const r = run({ tokenStatus: 200, manifestStatus: 200 })
    expect(r.status, r.out).toBe(0)
    expect(r.stdout).toContain('anonymously pullable')
  })

  it('fails on the exact 401 #2628 saw, and names the operator action', () => {
    const r = run({ tokenStatus: 401 })
    expect(r.status).not.toBe(0)
    expect(r.out).toContain('HTTP 401')
    expect(r.out).toContain('Change visibility')
    expect(r.out).toContain('::error')
  })

  it('fails when the token is granted but the tag cannot be fetched', () => {
    // A package that is public but has no `buildcache` tag (never pushed, or
    // pushed under a different path) is the same cold build for consumers.
    const r = run({ tokenStatus: 200, manifestStatus: 404 })
    expect(r.status).not.toBe(0)
    expect(r.out).toContain('HTTP 404')
  })

  it('fails when the token endpoint says 200 but hands back no token', () => {
    const r = run({ tokenStatus: 200, tokenBody: '{}' })
    expect(r.status).not.toBe(0)
    expect(r.out).toContain('no token')
  })

  it('sends no credential on the token request — it must behave like a consumer', () => {
    const r = run({ tokenStatus: 200, manifestStatus: 200 })
    const tokenCall = r.calls.split('\n').find((l) => l.includes('/token?')) ?? ''
    expect(tokenCall).not.toBe('')
    expect(tokenCall).not.toMatch(/Authorization|--user| -u /)
  })
})

describe('rail: the producer runs the check as its last step', () => {
  it('docker-buildcache.yml verifies anonymous pullability after pushing', () => {
    const job = getJob(loadWorkflow('docker-buildcache.yml'), 'refresh')
    const step = getStep(job, 'Verify the cache is anonymously pullable')
    expect(step.run).toContain('.github/scripts/check-buildcache-public.sh')
    expect(step['continue-on-error'], 'a soft check is the bug this rail exists to stop').not.toBe(true)
    // It must come after the export, or it checks yesterday's tag.
    const names = job.steps.map((s) => s.name)
    expect(names.indexOf('Verify the cache is anonymously pullable')).toBeGreaterThan(
      names.indexOf('Build app image and export layer cache'),
    )
    expect(names[names.length - 1]).toBe('Verify the cache is anonymously pullable')
  })
})
