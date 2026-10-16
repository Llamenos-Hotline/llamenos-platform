import { createPrivateKey, createSign } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { REPO } from './gh.js'
import { FLEET_DIR } from './paths.js'

/**
 * GitHub App authentication for the ONE call in this orchestrator that cannot
 * use the operator's own `gh` credentials: posting the `fleet/review` verdict
 * through the Checks API (`review-and-merge.ts`'s `postReviewCheckRun`).
 *
 * The Checks API refuses a personal access token outright —
 * `You must authenticate via a GitHub App. (HTTP 403)` — so until #1483's
 * `llamenos-fleet-review` App exists, `review-and-merge` performs a full
 * `opus` review and then cannot record it. In Actions the equivalent works
 * only because `GITHUB_TOKEN` is itself app-scoped.
 *
 * The obvious shortcut is rejected, permanently and on purpose:
 * `POST …/statuses` on a commit DOES accept a PAT and DOES satisfy a required
 * context — but a PAT-written green status under the same context name could
 * override a red check run. That is fail-open, and a review gate must fail
 * closed. The App is the only honest option (#1483).
 *
 * Three facts shape everything below:
 *
 *  1. **Fail closed, loudly.** There is no PAT fallback here and no path that
 *     returns a token it did not actually mint. Every failure throws
 *     `VerdictRecorderError`; `review-and-merge.ts` turns that into a stated
 *     refusal and a non-zero exit. A verdict that is quietly lost is worse
 *     than the 403, which at least shouts.
 *  2. **The private key, the JWT and the installation token never appear in
 *     output.** Not in a log line, not in an error message, not in a thrown
 *     exception's text. `scrubSecrets` is applied to every message this
 *     module constructs, and API error bodies are never included verbatim —
 *     only GitHub's own `message` field, itself scrubbed.
 *  3. **Nothing is persisted.** An installation token is valid for an hour;
 *     it is minted per invocation and lives only in a local variable. There
 *     is no cache file, no env var written back, no reuse across processes.
 *
 * The App needs exactly one permission (`checks: write`) and nothing else, so
 * the worst a leaked key could do is post a check-run conclusion — it cannot
 * read this repository's code, merge, push, or touch issues or pull requests.
 * See issue #1483 for the operator-facing half.
 */

// ---------------------------------------------------------------------------
// Where the two credentials live
// ---------------------------------------------------------------------------

/** The App ID is NOT a secret — an env var, set in `~/.llamenos-fleet/env`
 *  alongside the fleet's other non-secret runtime configuration. */
export const APP_ID_ENV = 'FLEET_REVIEW_APP_ID'

/** Overrides `REVIEW_APP_KEY_FILE`. Exists so tests can point at a throwaway
 *  keypair generated in-process rather than needing a real key at a fixed
 *  path — never so production can scatter the key somewhere else. */
export const APP_KEY_PATH_ENV = 'FLEET_REVIEW_APP_KEY_PATH'

/**
 * Optional. Skips the `GET /app/installations` round trip when the operator
 * already knows the id. Without it the installation is resolved by matching
 * `account.login` against this repo's owner, and an ambiguous result is a
 * refusal rather than a guess (see `resolveInstallationId`).
 */
export const APP_INSTALLATION_ENV = 'FLEET_REVIEW_APP_INSTALLATION_ID'

/** The PEM GitHub hands out once, at "Generate a private key". Derived from
 *  `FLEET_DIR` so it sits with every other piece of fleet runtime state, and
 *  so the `FLEET_HOME` test override reaches it like everything else. */
export const REVIEW_APP_KEY_FILE = join(FLEET_DIR, 'review-app.pem')

/** The key is a credential: group- or world-readable is a leak, reported as a
 *  hard refusal with the exact remedy, exactly as `fleet-env.ts` treats
 *  `~/.llamenos-fleet/env`. */
export const REQUIRED_KEY_MODE = 0o600

export const GITHUB_API = 'https://api.github.com'

// ---------------------------------------------------------------------------
// Secret hygiene
// ---------------------------------------------------------------------------

const REDACTED = '[redacted]'

/** Shortest literal this will substitute. A 1-3 character "secret" (an empty
 *  or truncated env value) would otherwise redact ordinary prose into
 *  unreadable noise, which is its own way of losing a diagnostic. */
const MIN_SCRUBBABLE_SECRET = 8

/**
 * Removes the three things that must never be printed: the PEM, the signed
 * JWT, and an installation token.
 *
 * Belt AND braces, deliberately. The literal pass handles the values this
 * process actually holds; the pattern pass catches a secret that arrived from
 * somewhere this call never had in a variable — most importantly a token
 * echoed back inside an API response body. Either pass alone has a gap, and a
 * scrubber with a gap is indistinguishable from no scrubber the one time it
 * matters.
 */
export function scrubSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text
  for (const s of secrets) {
    if (s.length < MIN_SCRUBBABLE_SECRET) continue
    out = out.split(s).join(REDACTED)
    // The same secret after someone else flattened its newlines — the shape
    // a PEM arrives in once it has been through a one-line log formatter.
    const flat = s.replace(/\s+/g, ' ').trim()
    if (flat !== s && flat.length >= MIN_SCRUBBABLE_SECRET) out = out.split(flat).join(REDACTED)
  }
  return out
    // A whole PEM block, however it got into the string.
    .replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, REDACTED)
    // A PEM whose END marker was cut off by a length cap: everything from
    // the BEGIN marker onwards is key material, so none of it survives. This
    // is the shape the paired pattern above misses, and the one a truncated
    // error message actually produces.
    .replace(/-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*/, REDACTED)
    // Every GitHub token prefix, installation tokens (`ghs_`) included.
    .replace(/\bgh[a-z]_[A-Za-z0-9_]{16,}/g, REDACTED)
    // The pre-prefix installation-token form GitHub still emits in places.
    .replace(/\bv1\.[0-9a-f]{40}\b/g, REDACTED)
    // Any JWT: a base64url triplet whose header starts with the `{"` of JSON.
    .replace(/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, REDACTED)
}

/**
 * Every failure in this module. Scrubs at construction, so there is no way to
 * build one of these carrying a secret even by accident — including the
 * `catch (e) { throw new VerdictRecorderError(String(e)) }` shape, which is
 * exactly how a key ends up in a log.
 *
 * Deliberately no `cause`: a cause chain is printed by default by Node's
 * uncaught-exception handler and by most loggers, which would reintroduce the
 * unscrubbed original text this class exists to keep out.
 */
export class VerdictRecorderError extends Error {
  constructor(message: string, secrets: readonly string[] = []) {
    super(scrubSecrets(message, secrets))
    this.name = 'VerdictRecorderError'
  }
}

/** One line for a human, scrubbed whatever the throw actually was. */
export function describeRecorderFailure(e: unknown, secrets: readonly string[] = []): string {
  if (e instanceof VerdictRecorderError) return e.message
  const raw = e instanceof Error ? (e.message || e.name) : String(e)
  // Scrub FIRST, then flatten and truncate. The other order is a real leak:
  // collapsing newlines defeats the literal match against a multi-line PEM,
  // and truncating can cut off the END marker the block pattern needs — a
  // test caught exactly that, with a key still in the message.
  return scrubSecrets(raw, secrets).replace(/\s+/g, ' ').slice(0, 300)
}

// ---------------------------------------------------------------------------
// Step 1 — read the two credentials, or refuse
// ---------------------------------------------------------------------------

export interface RecorderCredentials {
  appId: string
  privateKeyPem: string
  /** Set only when `FLEET_REVIEW_APP_INSTALLATION_ID` is. */
  installationId?: string
}

export interface CredentialIo {
  env?: Record<string, string | undefined>
  readFile?: (path: string) => string
  /** The file's permission bits, or `undefined` if it cannot be stat'd. */
  keyMode?: (path: string) => number | undefined
}

export function reviewAppKeyPath(env: Record<string, string | undefined> = process.env): string {
  const override = env[APP_KEY_PATH_ENV]?.trim()
  return override !== undefined && override !== '' ? override : REVIEW_APP_KEY_FILE
}

const realKeyMode = (path: string): number | undefined => {
  try {
    return statSync(path).mode & 0o777
  } catch {
    return undefined
  }
}

/**
 * Validates both credentials all the way to "this PEM is an RSA private key
 * Node can sign with" — not merely "the env var is set and the file exists".
 * A key that cannot sign is indistinguishable, from a caller's point of view,
 * from a key that is absent: both mean no verdict can be recorded, and both
 * must be found out BEFORE an expensive review runs rather than after.
 */
export function readRecorderCredentials(io: CredentialIo = {}): RecorderCredentials {
  const env = io.env ?? process.env
  const readFile = io.readFile ?? ((p: string) => readFileSync(p, 'utf8'))
  const keyMode = io.keyMode ?? realKeyMode

  const appId = (env[APP_ID_ENV] ?? '').trim()
  if (appId === '') {
    throw new VerdictRecorderError(
      `${APP_ID_ENV} is not set — the ${REPO} GitHub App that records the review verdict is not configured ` +
      `(see issue #1483; set ${APP_ID_ENV} in ~/.llamenos-fleet/env)`,
    )
  }
  if (!/^[0-9]+$/.test(appId)) {
    throw new VerdictRecorderError(`${APP_ID_ENV} must be the App's numeric ID — GitHub shows it on the App's settings page`)
  }

  const keyPath = reviewAppKeyPath(env)
  const mode = keyMode(keyPath)
  if (mode === undefined) {
    throw new VerdictRecorderError(
      `the GitHub App private key is missing at ${keyPath} — download it from the App's settings page ` +
      `("Generate a private key"), place it there with mode 600, or set ${APP_KEY_PATH_ENV}`,
    )
  }
  if (mode !== REQUIRED_KEY_MODE) {
    throw new VerdictRecorderError(
      `${keyPath} must be mode 0600 (found ${mode.toString(8).padStart(3, '0')}) — ` +
      `a group- or world-readable App key is a credential leak; run: chmod 600 ${keyPath}`,
    )
  }

  let privateKeyPem: string
  try {
    privateKeyPem = readFile(keyPath)
  } catch {
    throw new VerdictRecorderError(`${keyPath} is mode 0600 but could not be read`)
  }
  assertSignableRsaKey(privateKeyPem, keyPath)

  const installationId = (env[APP_INSTALLATION_ENV] ?? '').trim()
  if (installationId !== '' && !/^[0-9]+$/.test(installationId)) {
    throw new VerdictRecorderError(`${APP_INSTALLATION_ENV} must be numeric if set`)
  }

  return installationId === ''
    ? { appId, privateKeyPem }
    : { appId, privateKeyPem, installationId }
}

/**
 * Never re-raises OpenSSL's own error text. It does not normally contain key
 * material, but it is the one message in this module derived from the key
 * bytes themselves, and "probably safe" is not the standard here.
 */
function assertSignableRsaKey(pem: string, keyPath: string): void {
  let type: string | undefined
  try {
    type = createPrivateKey(pem).asymmetricKeyType
  } catch {
    throw new VerdictRecorderError(`${keyPath} is not a readable private key — re-download the App's PEM`)
  }
  if (type !== 'rsa') {
    throw new VerdictRecorderError(`${keyPath} holds a ${type} key, but a GitHub App JWT must be RS256-signed with the App's RSA key`)
  }
}

export type RecorderReadiness = { ok: true } | { ok: false; reason: string }

/**
 * The preflight `review-and-merge` runs BEFORE invoking the reviewer. Purely
 * local — no network, no token minted — because its whole purpose is to
 * refuse in milliseconds rather than after an `opus` review has been spent on
 * a verdict that cannot be recorded.
 */
export function checkVerdictRecorder(io: CredentialIo = {}): RecorderReadiness {
  try {
    readRecorderCredentials(io)
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: describeRecorderFailure(e) }
  }
}

// ---------------------------------------------------------------------------
// Step 2 — the App JWT (RS256, signed with the App's private key)
// ---------------------------------------------------------------------------

/** `iat` is backdated this far so a clock a minute fast on either side does
 *  not make GitHub reject the assertion as issued in the future. */
export const JWT_BACKDATE_SECONDS = 60

/** `exp - iat`. GitHub rejects anything over `JWT_MAX_LIFETIME_SECONDS`, and
 *  the backdate above is spent out of this same budget, so this is kept well
 *  under the cap rather than at it. */
export const JWT_LIFETIME_SECONDS = 480

/** GitHub's own hard cap on an App JWT's lifetime: ten minutes. */
export const JWT_MAX_LIFETIME_SECONDS = 600

const b64url = (data: Buffer | string): string =>
  (Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')).toString('base64url')

export interface AppJwtClaims {
  iss: string
  iat: number
  exp: number
}

/**
 * `node:crypto`'s `createSign('RSA-SHA256')` IS RS256 — there is no reason to
 * take a JWT dependency for one three-field assertion, and this repo takes
 * none (nothing in `package.json` provides one, and nothing was added).
 */
export function mintAppJwt(appId: string, privateKeyPem: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000) - JWT_BACKDATE_SECONDS
  const claims: AppJwtClaims = { iss: appId, iat, exp: iat + JWT_LIFETIME_SECONDS }
  const signingInput = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`
  let signature: Buffer
  try {
    signature = createSign('RSA-SHA256').update(signingInput).sign(createPrivateKey(privateKeyPem))
  } catch {
    // Same reasoning as `assertSignableRsaKey`: the underlying message is the
    // one thing here derived from the key bytes, so it is dropped entirely.
    throw new VerdictRecorderError('could not RS256-sign the GitHub App JWT with the configured private key')
  }
  return `${signingInput}.${b64url(signature)}`
}

// ---------------------------------------------------------------------------
// Step 3 — exchange the JWT for a short-lived installation token
// ---------------------------------------------------------------------------

export interface AppHttpRequest {
  method: 'GET' | 'POST'
  url: string
  /** The full `Authorization` header value — `Bearer <jwt>` for the two App
   *  endpoints below, `token <installation token>` for the repo call the
   *  caller makes with the result. */
  authorization: string
  body?: string
}

export interface AppHttpResponse {
  status: number
  body: string
}

export type AppHttp = (req: AppHttpRequest) => Promise<AppHttpResponse>

/**
 * `fetch`, not `gh api -H Authorization: ...`. Two reasons, both load-bearing:
 * `gh` would attach the operator's PAT and there is no per-call way to stop it
 * doing so, and a header passed to a subprocess puts the JWT (or the token) in
 * that process's argv, where every other user on the box can read it from
 * `/proc`. In-process `fetch` keeps both values in this process's heap and
 * nowhere else.
 */
export const fetchAppHttp: AppHttp = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: {
      authorization: req.authorization,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'llamenos-fleet',
      ...(req.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: req.body,
  })
  return { status: res.status, body: await res.text() }
}

/**
 * Runs one request and scrubs anything the transport throws. A `fetch`
 * rejection carries a cause chain this module has no control over, and the
 * request it describes carries the `Authorization` header — so the rejection
 * is never re-raised, only its scrubbed one-line description.
 */
export async function appApiRequest(
  http: AppHttp,
  req: AppHttpRequest,
  secrets: readonly string[],
  what: string,
): Promise<AppHttpResponse> {
  try {
    return await http(req)
  } catch (e) {
    throw new VerdictRecorderError(`${what} failed: ${describeRecorderFailure(e, secrets)}`, [...secrets, req.authorization])
  }
}

/**
 * GitHub's own error text for a failed call, and nothing else from the body.
 * The body of a token-exchange response contains the token on success and
 * could carry it on some failures, so it is never included verbatim — only
 * the `message` field, itself scrubbed.
 */
export function githubErrorDetail(body: string, secrets: readonly string[] = []): string {
  try {
    const parsed: unknown = JSON.parse(body)
    const message = (parsed as { message?: unknown } | null)?.message
    if (typeof message === 'string' && message.trim() !== '') {
      // Scrub before flatten/truncate — see `describeRecorderFailure`.
      return scrubSecrets(message, secrets).replace(/\s+/g, ' ').slice(0, 200)
    }
  } catch {
    // Not JSON — say so rather than echo whatever HTML a proxy returned.
  }
  return 'no error message in the response'
}

function parseJsonBody<T>(body: string, what: string, secrets: readonly string[]): T {
  try {
    return JSON.parse(body) as T
  } catch {
    // `JSON.parse`'s own message quotes a snippet of its input, which for
    // these endpoints is a response that may contain a token.
    throw new VerdictRecorderError(`${what} returned a body that is not JSON`, secrets)
  }
}

interface InstallationRow { id?: unknown; account?: { login?: unknown } | null }

/**
 * Matched by owner, and ambiguity is a refusal. The App is meant to be
 * installed on this one repository's owner only (#1483), so "zero matches" or
 * "more than one" both mean the operator's intent is unknown — and picking
 * the first installation on a list that happens to contain someone else's
 * account would post a verdict using the wrong installation's token.
 */
async function resolveInstallationId(http: AppHttp, jwt: string, secrets: readonly string[]): Promise<string> {
  const what = "listing the GitHub App's installations"
  const res = await appApiRequest(http, {
    method: 'GET', url: `${GITHUB_API}/app/installations`, authorization: `Bearer ${jwt}`,
  }, secrets, what)
  if (res.status !== 200) {
    throw new VerdictRecorderError(`${what} failed: HTTP ${res.status} — ${githubErrorDetail(res.body, secrets)}`, secrets)
  }
  const owner = (REPO.split('/')[0] ?? '').toLowerCase()
  const rows = parseJsonBody<InstallationRow[]>(res.body, what, secrets)
  const mine = (Array.isArray(rows) ? rows : []).filter(
    (r) => typeof r.account?.login === 'string' && r.account.login.toLowerCase() === owner,
  )
  if (mine.length !== 1) {
    throw new VerdictRecorderError(
      `the GitHub App has ${mine.length} installation(s) on ${owner} — install it on that account's ` +
      `${REPO} only, or set ${APP_INSTALLATION_ENV} to the installation to use`,
      secrets,
    )
  }
  const id = mine[0]?.id
  if (typeof id !== 'number' && typeof id !== 'string') {
    throw new VerdictRecorderError(`${what} returned an installation with no usable id`, secrets)
  }
  return String(id)
}

export interface MintTokenOptions extends CredentialIo {
  http?: AppHttp
  now?: () => number
}

/**
 * The whole exchange: credentials → RS256 JWT → installation id →
 * installation token. Returns the token to the caller and keeps no copy of it
 * anywhere — see this module's comment on why it is never persisted.
 */
export async function mintInstallationToken(opts: MintTokenOptions = {}): Promise<string> {
  const creds = readRecorderCredentials(opts)
  const jwt = mintAppJwt(creds.appId, creds.privateKeyPem, (opts.now ?? Date.now)())
  const secrets = [creds.privateKeyPem, jwt]
  const http = opts.http ?? fetchAppHttp

  const installationId = creds.installationId ?? await resolveInstallationId(http, jwt, secrets)

  const what = 'exchanging the GitHub App JWT for an installation token'
  const res = await appApiRequest(http, {
    method: 'POST',
    url: `${GITHUB_API}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    authorization: `Bearer ${jwt}`,
  }, secrets, what)
  if (res.status !== 201) {
    throw new VerdictRecorderError(`${what} failed: HTTP ${res.status} — ${githubErrorDetail(res.body, secrets)}`, secrets)
  }
  const token = parseJsonBody<{ token?: unknown }>(res.body, what, secrets).token
  if (typeof token !== 'string' || token.trim() === '') {
    throw new VerdictRecorderError(`${what} returned no token`, secrets)
  }
  return token
}
