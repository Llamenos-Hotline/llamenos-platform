import { describe, it, expect, vi } from 'vitest'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import {
  APP_ID_ENV, APP_INSTALLATION_ENV, APP_KEY_PATH_ENV, GITHUB_API,
  JWT_BACKDATE_SECONDS, JWT_LIFETIME_SECONDS, JWT_MAX_LIFETIME_SECONDS,
  REVIEW_APP_KEY_FILE, VerdictRecorderError,
  checkVerdictRecorder, describeRecorderFailure, githubErrorDetail, mintAppJwt,
  mintInstallationToken, readRecorderCredentials, reviewAppKeyPath, scrubSecrets,
  type AppHttp, type AppHttpRequest,
} from '../../orchestrator/src/github-app.js'
import { fakeInstallationToken, fakeOperatorPat } from './fake-credentials.js'

/**
 * #1483 — the GitHub App that records the `fleet/review` verdict does not
 * exist yet, and these tests must never need it to. Every assertion below
 * runs against a THROWAWAY RSA keypair generated in this process: nothing is
 * committed, nothing is read from the operator's real `~/.llamenos-fleet/`,
 * and `FLEET_REVIEW_APP_KEY_PATH` exists precisely so a test can say where
 * its own key lives.
 */
const throwaway = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const APP_ID = '1234567'
const INSTALLATION_ID = '98765432'
const INSTALLATION_TOKEN = fakeInstallationToken()
const SECOND_TOKEN = fakeInstallationToken('SecondInstallationTokenMintedAgain')
const OPERATOR_PAT = fakeOperatorPat()

/** A real file at mode 0600, because `readRecorderCredentials` deliberately
 *  refuses a group- or world-readable App key. */
function writeKeyFile(pem: string = throwaway.privateKey): string {
  const dir = mkdtempSync(join(tmpdir(), 'llamenos-app-key-'))
  const path = join(dir, 'review-app.pem')
  writeFileSync(path, pem)
  chmodSync(path, 0o600)
  return path
}

const keyPath = writeKeyFile()

const env = (over: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  [APP_ID_ENV]: APP_ID,
  [APP_KEY_PATH_ENV]: keyPath,
  ...over,
})

interface Recorded { requests: AppHttpRequest[]; http: AppHttp }

/** The happy-path GitHub, recording every request so the tests can assert
 *  WHICH credential each call carried — the whole point of this exercise. */
function recordingHttp(over: {
  installations?: { status: number; body: string }
  accessToken?: { status: number; body: string }
} = {}): Recorded {
  const requests: AppHttpRequest[] = []
  const http: AppHttp = async (req) => {
    requests.push(req)
    if (req.url.endsWith('/app/installations')) {
      return over.installations ?? {
        status: 200,
        body: JSON.stringify([{ id: Number(INSTALLATION_ID), account: { login: 'Llamenos-Hotline' } }]),
      }
    }
    if (req.url.includes('/access_tokens')) {
      return over.accessToken ?? {
        status: 201,
        body: JSON.stringify({ token: INSTALLATION_TOKEN, expires_at: '2026-10-03T12:00:00Z' }),
      }
    }
    throw new Error(`unexpected request to ${req.url}`)
  }
  return { requests, http }
}

function decodeJwt(jwt: string): { header: Record<string, unknown>; claims: Record<string, unknown> } {
  const [h, p] = jwt.split('.')
  return {
    header: JSON.parse(Buffer.from(h ?? '', 'base64url').toString('utf8')) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(p ?? '', 'base64url').toString('utf8')) as Record<string, unknown>,
  }
}

// ---------------------------------------------------------------------------
// The JWT itself
// ---------------------------------------------------------------------------

describe('mintAppJwt', () => {
  const NOW_MS = 1_767_225_600_000 // 2026-01-01T00:00:00Z
  const NOW = NOW_MS / 1000

  it('is a three-part JWT whose header declares RS256', () => {
    const jwt = mintAppJwt(APP_ID, throwaway.privateKey, NOW_MS)
    expect(jwt.split('.')).toHaveLength(3)
    expect(decodeJwt(jwt).header).toEqual({ alg: 'RS256', typ: 'JWT' })
  })

  it('issues as the App ID, backdated, and expiring well inside GitHub\'s ten-minute cap', () => {
    const { claims } = decodeJwt(mintAppJwt(APP_ID, throwaway.privateKey, NOW_MS))
    expect(claims['iss']).toBe(APP_ID)
    expect(claims['iat']).toBe(NOW - JWT_BACKDATE_SECONDS)
    expect(claims['exp']).toBe(NOW - JWT_BACKDATE_SECONDS + JWT_LIFETIME_SECONDS)
  })

  // The constraint GitHub actually enforces, asserted on the VALUES in the
  // token rather than on the two constants — a change to either that broke
  // the property would otherwise still pass.
  it('exp - iat is never more than 600 seconds', () => {
    for (const nowMs of [0, NOW_MS, Date.now(), NOW_MS + 999]) {
      const { claims } = decodeJwt(mintAppJwt(APP_ID, throwaway.privateKey, nowMs))
      const span = Number(claims['exp']) - Number(claims['iat'])
      expect(span).toBeGreaterThan(0)
      expect(span).toBeLessThanOrEqual(JWT_MAX_LIFETIME_SECONDS)
    }
  })

  it('iat is in the past, so a slightly fast clock cannot make GitHub reject it', () => {
    const { claims } = decodeJwt(mintAppJwt(APP_ID, throwaway.privateKey, NOW_MS))
    expect(Number(claims['iat'])).toBeLessThan(NOW)
  })

  // Proves it is really RS256 over the real key, not a plausible-looking
  // base64 blob: the App's own PUBLIC key verifies the signature.
  it('signs the header.payload with the App private key, verifiable by its public key', () => {
    const jwt = mintAppJwt(APP_ID, throwaway.privateKey, NOW_MS)
    const [h, p, sig] = jwt.split('.')
    const ok = createVerify('RSA-SHA256')
      .update(`${h}.${p}`)
      .verify(throwaway.publicKey, Buffer.from(sig ?? '', 'base64url'))
    expect(ok).toBe(true)
  })

  it('a signature from a DIFFERENT key does not verify — the check above is not vacuous', () => {
    const other = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    const jwt = mintAppJwt(APP_ID, other.privateKey, NOW_MS)
    const [h, p, sig] = jwt.split('.')
    expect(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(throwaway.publicKey, Buffer.from(sig ?? '', 'base64url')))
      .toBe(false)
  })

  it('refuses a non-RSA key rather than emitting an unsignable assertion', () => {
    const ed = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    expect(() => mintAppJwt(APP_ID, ed.privateKey, NOW_MS)).toThrow(VerdictRecorderError)
  })
})

// ---------------------------------------------------------------------------
// Which token goes where — the property the whole feature turns on
// ---------------------------------------------------------------------------

describe('mintInstallationToken', () => {
  it('sends the JWT as Bearer to both App endpoints, in order, and returns the installation token', async () => {
    const { requests, http } = recordingHttp()
    const token = await mintInstallationToken({ env: env(), http })

    expect(token).toBe(INSTALLATION_TOKEN)
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${GITHUB_API}/app/installations`,
      `POST ${GITHUB_API}/app/installations/${INSTALLATION_ID}/access_tokens`,
    ])

    const jwts = new Set<string>()
    for (const r of requests) {
      expect(r.authorization).toMatch(/^Bearer /)
      const jwt = r.authorization.slice('Bearer '.length)
      expect(decodeJwt(jwt).header['alg']).toBe('RS256')
      jwts.add(jwt)
    }
    // One assertion, one JWT: both calls carry the same minted assertion.
    expect(jwts.size).toBe(1)
  })

  it('never sends the installation token to the endpoints that mint it (not the other way round)', async () => {
    const { requests, http } = recordingHttp()
    await mintInstallationToken({ env: env(), http })
    for (const r of requests) {
      expect(r.authorization).not.toContain(INSTALLATION_TOKEN)
      expect(r.authorization).not.toMatch(/^token /)
    }
  })

  it('never sends the operator\'s PAT, and never reads one', async () => {
    const { requests, http } = recordingHttp()
    await mintInstallationToken({
      env: env({ GH_TOKEN: OPERATOR_PAT, GITHUB_TOKEN: OPERATOR_PAT }),
      http,
    })
    for (const r of requests) {
      expect(r.authorization).not.toContain(OPERATOR_PAT)
    }
  })

  it('skips the installation lookup entirely when the id is configured', async () => {
    const { requests, http } = recordingHttp()
    const token = await mintInstallationToken({ env: env({ [APP_INSTALLATION_ENV]: '555' }), http })
    expect(token).toBe(INSTALLATION_TOKEN)
    expect(requests.map((r) => r.url)).toEqual([`${GITHUB_API}/app/installations/555/access_tokens`])
  })

  // Not persisted: a second invocation mints again rather than reusing
  // anything cached in this process, on disk, or in the environment.
  it('mints per invocation — nothing is cached between calls', async () => {
    const first = await mintInstallationToken({ env: env(), http: recordingHttp().http })
    const second = await mintInstallationToken({
      env: env(),
      http: recordingHttp({ accessToken: { status: 201, body: JSON.stringify({ token: SECOND_TOKEN }) } }).http,
    })
    expect(first).toBe(INSTALLATION_TOKEN)
    expect(second).toBe(SECOND_TOKEN)
  })
})

// ---------------------------------------------------------------------------
// Fail closed, every way the credentials can be wrong
// ---------------------------------------------------------------------------

describe('readRecorderCredentials fails closed', () => {
  it('refuses when the App ID is absent, and names the env var and the issue', () => {
    const r = checkVerdictRecorder({ env: env({ [APP_ID_ENV]: undefined }) })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toContain(APP_ID_ENV)
    expect(!r.ok && r.reason).toContain('#1483')
  })

  it('refuses when the App ID is blank or not numeric', () => {
    expect(checkVerdictRecorder({ env: env({ [APP_ID_ENV]: '   ' }) }).ok).toBe(false)
    expect(checkVerdictRecorder({ env: env({ [APP_ID_ENV]: 'llamenos-fleet-review' }) }).ok).toBe(false)
  })

  it('refuses when the private key file does not exist, naming the path', () => {
    const missing = join(tmpdir(), 'llamenos-no-such-review-app.pem')
    const r = checkVerdictRecorder({ env: env({ [APP_KEY_PATH_ENV]: missing }) })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toContain(missing)
  })

  it('refuses a group- or world-readable key, with the chmod that fixes it', () => {
    const loose = writeKeyFile()
    chmodSync(loose, 0o644)
    const r = checkVerdictRecorder({ env: env({ [APP_KEY_PATH_ENV]: loose }) })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toContain('chmod 600')
  })

  it('refuses a file that is not a private key at all', () => {
    const junk = writeKeyFile('this is not a PEM\n')
    const r = checkVerdictRecorder({ env: env({ [APP_KEY_PATH_ENV]: junk }) })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toContain('not a readable private key')
  })

  it('refuses a well-formed key of the wrong type', () => {
    const ed = generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
    const r = checkVerdictRecorder({ env: env({ [APP_KEY_PATH_ENV]: writeKeyFile(ed.privateKey) }) })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toContain('RS256')
  })

  it('accepts a complete, correctly-permissioned pair', () => {
    expect(checkVerdictRecorder({ env: env() })).toEqual({ ok: true })
    expect(readRecorderCredentials({ env: env() }).appId).toBe(APP_ID)
  })

  it('defaults the key path to ~/.llamenos-fleet/review-app.pem when unset', () => {
    expect(reviewAppKeyPath({})).toBe(REVIEW_APP_KEY_FILE)
    expect(reviewAppKeyPath({ [APP_KEY_PATH_ENV]: '  ' })).toBe(REVIEW_APP_KEY_FILE)
    expect(reviewAppKeyPath({ [APP_KEY_PATH_ENV]: '/tmp/k.pem' })).toBe('/tmp/k.pem')
  })
})

describe('mintInstallationToken fails closed on every API outcome short of a token', () => {
  it('throws on a 401 from the token exchange — never returns a token it did not get', async () => {
    const { http } = recordingHttp({
      accessToken: { status: 401, body: JSON.stringify({ message: 'A JSON web token could not be decoded' }) },
    })
    await expect(mintInstallationToken({ env: env(), http })).rejects.toThrow(/HTTP 401/)
  })

  it('throws on a 403 from the installations listing', async () => {
    const { http } = recordingHttp({ installations: { status: 403, body: JSON.stringify({ message: 'Forbidden' }) } })
    await expect(mintInstallationToken({ env: env(), http })).rejects.toThrow(/HTTP 403/)
  })

  it('throws on a 201 that carries no token', async () => {
    const { http } = recordingHttp({ accessToken: { status: 201, body: JSON.stringify({ expires_at: 'soon' }) } })
    await expect(mintInstallationToken({ env: env(), http })).rejects.toThrow(/returned no token/)
  })

  it('throws on a 201 whose body is not JSON', async () => {
    const { http } = recordingHttp({ accessToken: { status: 201, body: '<html>502</html>' } })
    await expect(mintInstallationToken({ env: env(), http })).rejects.toThrow(/not JSON/)
  })

  it('throws when the transport itself throws, without re-raising the transport error', async () => {
    const http: AppHttp = async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com') }
    await expect(mintInstallationToken({ env: env(), http })).rejects.toThrow(VerdictRecorderError)
  })

  it('refuses an ambiguous installation list rather than guessing one', async () => {
    const two = JSON.stringify([
      { id: 1, account: { login: 'Llamenos-Hotline' } },
      { id: 2, account: { login: 'llamenos-hotline' } },
    ])
    await expect(mintInstallationToken({ env: env(), http: recordingHttp({ installations: { status: 200, body: two } }).http }))
      .rejects.toThrow(/2 installation\(s\)/)
  })

  it('refuses an installation list with no entry for this repo\'s owner', async () => {
    const other = JSON.stringify([{ id: 7, account: { login: 'someone-else' } }])
    await expect(mintInstallationToken({ env: env(), http: recordingHttp({ installations: { status: 200, body: other } }).http }))
      .rejects.toThrow(/0 installation\(s\)/)
  })

  it('does not attempt the exchange at all when the credentials are unusable', async () => {
    const { requests, http } = recordingHttp()
    await expect(mintInstallationToken({ env: env({ [APP_ID_ENV]: undefined }), http })).rejects.toThrow()
    expect(requests).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Secret hygiene
// ---------------------------------------------------------------------------

describe('secret hygiene', () => {
  const SECRETS = [throwaway.privateKey, INSTALLATION_TOKEN]

  function assertClean(text: string, jwt?: string): void {
    expect(text).not.toContain(throwaway.privateKey)
    // Not just the whole PEM — any interior line of it is key material too.
    for (const line of throwaway.privateKey.split('\n')) {
      if (line.length > 20 && !line.startsWith('-----')) expect(text).not.toContain(line)
    }
    expect(text).not.toContain(INSTALLATION_TOKEN)
    if (jwt !== undefined) expect(text).not.toContain(jwt)
  }

  it('scrubs a PEM, a JWT and a token passed through it', () => {
    const jwt = mintAppJwt(APP_ID, throwaway.privateKey, Date.now())
    const noisy = `key=${throwaway.privateKey} jwt=${jwt} token=${INSTALLATION_TOKEN}`
    assertClean(scrubSecrets(noisy, SECRETS), jwt)
  })

  it('scrubs a token and a JWT it was never told about, by shape alone', () => {
    const jwt = mintAppJwt(APP_ID, throwaway.privateKey, Date.now())
    const out = scrubSecrets(`leaked ${INSTALLATION_TOKEN} and ${jwt} and ${throwaway.privateKey}`, [])
    assertClean(out, jwt)
  })

  it('VerdictRecorderError cannot be constructed carrying a secret', () => {
    const jwt = mintAppJwt(APP_ID, throwaway.privateKey, Date.now())
    const e = new VerdictRecorderError(`boom: ${throwaway.privateKey} / ${jwt} / ${INSTALLATION_TOKEN}`)
    assertClean(e.message, jwt)
  })

  it('describeRecorderFailure scrubs a raw thrown Error that quotes the key', () => {
    assertClean(describeRecorderFailure(new Error(`openssl choked on ${throwaway.privateKey}`), SECRETS))
  })

  it('never echoes an API error body verbatim — including one that contains the token', async () => {
    const leaky = JSON.stringify({
      message: `bad credential ${INSTALLATION_TOKEN}`,
      token: INSTALLATION_TOKEN,
      documentation_url: 'https://docs.github.com',
    })
    const { http } = recordingHttp({ accessToken: { status: 401, body: leaky } })
    const e = await mintInstallationToken({ env: env(), http }).catch((err: unknown) => err)
    expect(e).toBeInstanceOf(VerdictRecorderError)
    const message = (e as Error).message
    assertClean(message)
    expect(message).toContain('HTTP 401')
    expect(message, 'the body must not be pasted in whole').not.toContain('documentation_url')
  })

  it('githubErrorDetail keeps GitHub\'s message and nothing else', () => {
    expect(githubErrorDetail(JSON.stringify({ message: 'Resource not accessible by integration' })))
      .toBe('Resource not accessible by integration')
    expect(githubErrorDetail('<html>bad gateway</html>')).toBe('no error message in the response')
    assertClean(githubErrorDetail(JSON.stringify({ message: INSTALLATION_TOKEN })))
  })

  it('does not redact ordinary prose just because a "secret" was short or empty', () => {
    expect(scrubSecrets('nothing to see here', ['', 'a', 'abc'])).toBe('nothing to see here')
  })

  // Every message this module can produce, swept in one pass: if any failure
  // path ever starts quoting the key or the token, this catches it without
  // needing a new test per path.
  it('no failure path produces a message containing the key or the token', async () => {
    const jwt = mintAppJwt(APP_ID, throwaway.privateKey, Date.now())
    const leakyBody = JSON.stringify({ message: throwaway.privateKey, token: INSTALLATION_TOKEN })
    const cases: (() => Promise<unknown>)[] = [
      () => mintInstallationToken({ env: env({ [APP_ID_ENV]: undefined }), http: recordingHttp().http }),
      () => mintInstallationToken({ env: env({ [APP_KEY_PATH_ENV]: '/nope.pem' }), http: recordingHttp().http }),
      () => mintInstallationToken({ env: env(), http: recordingHttp({ installations: { status: 500, body: leakyBody } }).http }),
      () => mintInstallationToken({ env: env(), http: recordingHttp({ accessToken: { status: 401, body: leakyBody } }).http }),
      // A 201 that is leaky AND tokenless: the success shape must not be
      // used here, because a 201 carrying a real token is not a failure.
      () => mintInstallationToken({
        env: env(),
        http: recordingHttp({ accessToken: { status: 201, body: JSON.stringify({ message: throwaway.privateKey }) } }).http,
      }),
      () => mintInstallationToken({ env: env(), http: async () => { throw new Error(`transport saw ${jwt}`) } }),
    ]
    for (const run of cases) {
      const e = await run().then(() => undefined, (err: unknown) => err)
      expect(e).toBeInstanceOf(Error)
      assertClean(`${(e as Error).name}: ${(e as Error).message}`, jwt)
      expect((e as Error & { cause?: unknown }).cause, 'a cause chain would reprint the unscrubbed original').toBeUndefined()
    }
  })

  it('never logs anything at all from this module', async () => {
    const spies = ([['log', 'log'], ['error', 'error'], ['warn', 'warn'], ['debug', 'debug']] as const)
      .map(([k]) => vi.spyOn(console, k).mockImplementation(() => {}))
    try {
      await mintInstallationToken({ env: env(), http: recordingHttp().http })
      await mintInstallationToken({ env: env({ [APP_ID_ENV]: undefined }) }).catch(() => undefined)
    } finally {
      for (const s of spies) s.mockRestore()
    }
    for (const s of spies) expect(s).not.toHaveBeenCalled()
  })
})
