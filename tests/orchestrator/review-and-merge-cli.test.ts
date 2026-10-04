import { describe, it, expect } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { execFileSync } from 'node:child_process'

/**
 * #1483, end to end through the REAL `llamenos-fleet review-and-merge`
 * process — argv parsing, `defaultReviewAndMergeDeps`, the real
 * `checkVerdictRecorder`, the real `describeOutcome`, the real exit code.
 *
 * The in-process tests next door prove the refusal logic; this one proves
 * the thing a unit test structurally cannot: that an operator running the
 * actual command sees a refusal on its actual stdout/stderr, that the
 * process exits non-zero, that NOTHING was written to GitHub, and that no
 * key material appears anywhere in the captured output — including a stack
 * trace, which no in-process assertion would ever see.
 *
 * Offline by construction. `gh` is replaced on PATH by a stub that answers
 * the four read calls this path makes and logs every invocation, so the test
 * can assert no write was attempted; and every case below refuses at the
 * local credential preflight, before any GitHub App endpoint is reached.
 */

const CLI = join(process.cwd(), 'orchestrator', 'src', 'cli.ts')

/** A real RSA key, used only to make the "corrupt key" case genuinely carry
 *  key material in memory — never written anywhere but a temp file. */
const throwaway = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const GH_STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_STUB_LOG"
for a in "$@"; do
  case "$a" in
    state) echo '{"state":"OPEN"}'; exit 0;;
    headRefOid,baseRefOid,headRefName,files,author)
      echo '{"headRefOid":"head111","baseRefOid":"base000","headRefName":"fleet/infra/9","files":[{"path":"README.md","additions":1,"deletions":0}],"author":{"login":"rhonda-rodododo","is_bot":false}}'
      exit 0;;
    labels,title,body) echo '{"labels":[],"title":"t","body":"b"}'; exit 0;;
    headRefOid) echo '{"headRefOid":"head111"}'; exit 0;;
  esac
done
if [ "$1" = "api" ]; then echo '{"total_count":0,"check_runs":[]}'; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then echo '[]'; exit 0; fi
echo "stub gh: unexpected invocation: $*" >&2
exit 1
`

interface Run { status: number; stdout: string; stderr: string; ghCalls: string }

function runCli(env: Record<string, string | undefined>): Run {
  const sandbox = mkdtempSync(join(tmpdir(), 'llamenos-ram-cli-'))
  const bin = join(sandbox, 'bin')
  mkdirSync(bin)
  const ghPath = join(bin, 'gh')
  writeFileSync(ghPath, GH_STUB)
  chmodSync(ghPath, 0o755)
  const ghLog = join(sandbox, 'gh-calls.log')
  writeFileSync(ghLog, '')

  const full: Record<string, string> = {}
  for (const [k, v] of Object.entries({
    ...process.env,
    PATH: `${bin}:${process.env['PATH'] ?? ''}`,
    FLEET_HOME: join(sandbox, 'home'),
    GH_STUB_LOG: ghLog,
    // Not inherited into the child: the suite's own process may well have
    // real credentials, and a case that says "the App ID is absent" must
    // actually be absent.
    FLEET_REVIEW_APP_ID: undefined,
    FLEET_REVIEW_APP_KEY_PATH: undefined,
    FLEET_REVIEW_APP_INSTALLATION_ID: undefined,
    ...env,
  })) {
    if (v !== undefined) full[k] = v
  }
  mkdirSync(full['FLEET_HOME'] ?? join(sandbox, 'home'), { recursive: true })

  let status = 0
  let stdout = ''
  let stderr = ''
  try {
    stdout = execFileSync('bun', [CLI, 'review-and-merge', '9'], {
      env: full, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    status = err.status ?? -1
    stdout = err.stdout ?? ''
    stderr = err.stderr ?? ''
  }
  return { status, stdout, stderr, ghCalls: existsSync(ghLog) ? readFileSync(ghLog, 'utf8') : '' }
}

/** Nothing in this output may look like a credential — and nothing in the
 *  `gh` call log may be a write. */
function assertRefusedCleanly(r: Run): void {
  const all = `${r.stdout}\n${r.stderr}`
  expect(r.status, `expected a non-zero exit; got ${r.status}\n${all}`).not.toBe(0)
  expect(all).toMatch(/cannot record|NOT reviewed/)
  expect(all).toContain('Nothing was posted')
  expect(all).toContain('#1483')
  // No PEM, no JWT, no token shape, anywhere.
  expect(all).not.toContain('PRIVATE KEY')
  for (const line of throwaway.privateKey.split('\n')) {
    if (line.length > 20 && !line.startsWith('-----')) expect(all).not.toContain(line)
  }
  expect(all, 'a JWT reached the output').not.toMatch(/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/)
  expect(all, 'a token shape reached the output').not.toMatch(/\bgh[a-z]_[A-Za-z0-9_]{16,}/)
  // Nothing was WRITTEN to GitHub by any route. (The freshness lookup is a
  // GET whose path legitimately contains `check-runs`, so the pattern is
  // about the verbs and the write subcommands, not the endpoint name.)
  expect(r.ghCalls).not.toMatch(/-X POST|--method POST|-X PATCH|pr merge|pr review|pr edit/)
}

describe('llamenos-fleet review-and-merge refuses, out loud, with no App credentials (#1483)', () => {
  it('with no FLEET_REVIEW_APP_ID: exits non-zero, says nothing was posted, writes nothing', () => {
    const r = runCli({})
    assertRefusedCleanly(r)
    expect(r.stdout).toContain('FLEET_REVIEW_APP_ID')
    // It got far enough to read the PR — the refusal is the recorder
    // preflight, not a stub-gh accident.
    expect(r.ghCalls).toContain('pr view 9')
  })

  it('with the key path pointing at a missing file: same refusal, naming the path', () => {
    const missing = join(tmpdir(), 'llamenos-definitely-absent-review-app.pem')
    const r = runCli({ FLEET_REVIEW_APP_ID: '1234567', FLEET_REVIEW_APP_KEY_PATH: missing })
    assertRefusedCleanly(r)
    expect(r.stdout).toContain(missing)
  })

  // The non-vacuous hygiene case: this key file IS read into the process's
  // memory (the App ID is valid and the mode is right) and then fails to
  // parse, so the failure path runs with real key material in hand.
  it('with a corrupt key that IS read: refuses without putting any of its bytes in the output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llamenos-corrupt-key-'))
    const path = join(dir, 'review-app.pem')
    // A real PEM with its body mangled: same shape, same length, unparseable.
    writeFileSync(path, throwaway.privateKey.replace(/MII/, 'XII'))
    chmodSync(path, 0o600)

    const r = runCli({ FLEET_REVIEW_APP_ID: '1234567', FLEET_REVIEW_APP_KEY_PATH: path })
    assertRefusedCleanly(r)
    expect(r.stdout).toContain('not a readable private key')
    // Specifically: not one body line of the file it just read.
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (line.length > 20 && !line.startsWith('-----')) expect(`${r.stdout}${r.stderr}`).not.toContain(line)
    }
  })

  it('with a group-readable key: refuses with the chmod that fixes it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llamenos-loose-key-'))
    const path = join(dir, 'review-app.pem')
    writeFileSync(path, throwaway.privateKey)
    chmodSync(path, 0o644)
    const r = runCli({ FLEET_REVIEW_APP_ID: '1234567', FLEET_REVIEW_APP_KEY_PATH: path })
    assertRefusedCleanly(r)
    expect(r.stdout).toContain('chmod 600')
  })
})
