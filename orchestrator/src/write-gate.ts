import {
  CERTIFICATE_ONLY_PATTERNS, matchesPath, matchesSecretPath, publicCertificateVerdict,
} from './fragments.js'
import { SECRET_PATH_PATTERNS, TRUST_ANCHOR_APPROVERS, TRUST_ANCHOR_FILES, type TrustAnchorFile } from './config.js'
import { findPrivateKeyMaterial, latin1 } from './key-material.js'

/**
 * The write gate's classification of a changed file (#2556). Three answers,
 * each with its own remedy, and each refusal says which one it is:
 *
 * 1. **secret** — never agent-writable, and no approval clears it. A path
 *    matching `SECRET_PATH_PATTERNS` (minus the committed-template and
 *    public-certificate carve-outs), or ANY file whose content holds private
 *    key material (`findPrivateKeyMaterial`), wherever it sits — `tests/`,
 *    `testdata/` and a `.ts` source file included. A path is a guess; the
 *    bytes are the fact, so both are checked.
 * 2. **trust anchor** — a file that decides which certificates a shipped
 *    client accepts (`TRUST_ANCHOR_FILES`), or a diff that changes a trust
 *    signature line in shipped client source (`TRUST_SIGNATURES`). Writable,
 *    but it lands only once a human in `TRUST_ANCHOR_APPROVERS` has approved
 *    the exact commit under judgement. A pin list is source code, not a key,
 *    so no content rule could put it here — the registry does.
 * 3. **writable** — everything else, including a public certificate chain
 *    used as test input, which is published data and carries no secret.
 *
 * Before #2556 the gate had only the first class, decided by path alone, and
 * it was inverted relative to risk: it refused two public Let's Encrypt
 * chains #2550 needed as test input, while the five files that decide what
 * our clients trust were freely writable and its message ("touched
 * never-write paths") could not say which of those situations it was in.
 *
 * Pure: every function here takes the bytes and the diff text it judges. The
 * reading is done once, in `verifyMechanical` (verify.ts), inside the trusted
 * base checkout with the head commit as data.
 */

/** How a content finding's reason begins — the refusal keys its remedy on it. */
const CONTENT_KEY_WHY = 'its content holds'

/** A file's bytes as read from the commit under judgement. A string is
 *  accepted too (treated as latin1) so pure callers and tests can pass text. */
export type FileContent = string | Uint8Array

function asText(c: FileContent): string {
  return typeof c === 'string' ? c : latin1(c)
}

function asBytes(c: FileContent): Uint8Array {
  return typeof c === 'string' ? Buffer.from(c, 'latin1') : c
}

/** The first secret pattern a file's PATH matches without a carve-out
 *  applying, and why — or `undefined`. */
function pathSecretFinding(file: string, patterns: readonly string[], text: string | undefined): string | undefined {
  const lookup = text === undefined ? undefined : () => text
  for (const p of patterns) {
    if (!matchesSecretPath(file, p, lookup)) continue
    if (CERTIFICATE_ONLY_PATTERNS.includes(p)) {
      if (text === undefined) {
        return `its path matches secret pattern "${p}" and there is no content to show it is a public certificate ` +
          '(deleted, or not read)'
      }
      const verdict = publicCertificateVerdict(text)
      // `matchesSecretPath` already said "not public"; the verdict says why.
      const why = verdict.public ? 'its content is not provably public' : verdict.reason
      return `its path matches secret pattern "${p}" and its content is not provably public certificate material: ${why}`
    }
    return `its path matches secret pattern "${p}"`
  }
  return undefined
}

/**
 * Why `file` is never agent-writable, or `undefined` when it is not a secret.
 *
 * `content` is the file as the head commit holds it, or `undefined` when there
 * is none to read (a deletion, or a caller with no content lookup). Without
 * content only the path half can speak — the pre-#2556 behaviour, where
 * every `*.pem` is a secret — so callers that CAN read the bytes must: the
 * content half is the one that sees a key under a harmless name.
 *
 * Checked in this order, so the reason names the decisive fact first: the
 * path, then the bytes. A template (`.env.example`) is exempt from the path
 * half only; a real key pasted into it is still found by the content half.
 */
export function secretFinding(
  file: string,
  patterns: readonly string[] = SECRET_PATH_PATTERNS,
  content?: FileContent,
): string | undefined {
  const byPath = pathSecretFinding(file, patterns, content === undefined ? undefined : asText(content))
  if (byPath !== undefined) return byPath
  if (content === undefined) return undefined
  const key = findPrivateKeyMaterial(asBytes(content))
  return key === undefined ? undefined : `${CONTENT_KEY_WHY} ${key.kind} (line ${key.line})`
}

// ---------------------------------------------------------------------------
// Trust anchors.
// ---------------------------------------------------------------------------

/**
 * Where shipped client code lives — the only places a trust SIGNATURE means a
 * shipped trust decision. Tests, debug variants (`apps/android/app/src/debug/`
 * carries its own `network_security_config.xml` with no pins, by design) and
 * tooling are excluded: they do not ship, and their trust code is test input.
 */
export const SHIPPED_CLIENT_SOURCE_ROOTS: readonly string[] = [
  'apps/android/app/src/main/',
  'apps/ios/Sources/',
  'apps/desktop/src/',
]

/** A line shape that carries a TLS trust decision in client source. */
export interface TrustSignature {
  /** Shown in the refusal: what the changed line is. */
  name: string
  re: RegExp
}

/**
 * The line shapes that MAKE a TLS trust decision in shipped client source:
 * a pin literal, or the API through which a client chooses which
 * certificates to accept. A diff that adds or removes one of these lines in
 * a file under `SHIPPED_CLIENT_SOURCE_ROOTS` is a trust-anchor change even
 * when the file is not in `TRUST_ANCHOR_FILES` — this is how "any future
 * equivalent" (#2556 property 3) is caught at the gate, not just in review:
 * a new `NewPinner.kt`, a `.certificatePinner(…)` call removed from a socket
 * builder, an `X509TrustManager` that trusts everything.
 *
 * Specific on purpose. Each was checked against the tracked shipped sources
 * (the discovery rail in `write-gate-properties.test.ts`): only the
 * registered files and four known call sites contain any of them, so an
 * ordinary client change does not trip this.
 */
export const TRUST_SIGNATURES: readonly TrustSignature[] = [
  { name: 'an SPKI pin literal (sha256/…)', re: /sha256\/[A-Za-z0-9+/]{43}=/ },
  { name: 'an Android network-security trust element', re: /<(pin-set|pin\b|trust-anchors|certificates\b)/ },
  {
    name: 'an OkHttp/JSSE trust hook',
    re: /CertificatePinner|certificatePinner\(|X509TrustManager|HostnameVerifier|hostnameVerifier\(|sslSocketFactory\(/,
  },
  { name: 'an Apple Security trust API', re: /\bSecTrust[A-Za-z]*|serverTrust|CertificatePinValidator|CertificatePins/ },
  {
    name: 'a rustls/reqwest trust hook',
    re: /ServerCertVerifier|RootCertStore|danger_accept_invalid|add_root_certificate|tls_built_in_root_certs|\.dangerous\(\)|cert_pin::/,
  },
  { name: 'a SIP TLS trust anchor', re: /[Tt]lsTrustAnchor/ },
]

export function trustAnchorEntry(file: string): TrustAnchorFile | undefined {
  return TRUST_ANCHOR_FILES.find((e) => e.path === file)
}

/** True for a file under `SHIPPED_CLIENT_SOURCE_ROOTS`. */
export function isShippedClientSource(file: string): boolean {
  return SHIPPED_CLIENT_SOURCE_ROOTS.some((r) => matchesPath(file, r))
}

const MAX_QUOTED_LINE = 100

/**
 * Why changing `file` is a trust-anchor change, or `undefined`.
 *
 * `changedLines` are the lines the diff adds or removes in that file (see
 * `changedLinesByFile`), signs stripped. A registered file is a trust anchor
 * whatever its diff says — deleting or renaming it included.
 */
export function trustAnchorFinding(file: string, changedLines: readonly string[] = []): string | undefined {
  const entry = trustAnchorEntry(file)
  if (entry !== undefined) return `it is ${entry.anchors}`
  if (!isShippedClientSource(file)) return undefined
  for (const line of changedLines) {
    const sig = TRUST_SIGNATURES.find((s) => s.re.test(line))
    if (sig === undefined) continue
    const quoted = line.trim().length > MAX_QUOTED_LINE ? `${line.trim().slice(0, MAX_QUOTED_LINE)}…` : line.trim()
    return `its diff changes ${sig.name} in shipped client source: \`${quoted}\``
  }
  return undefined
}

/** Undo git's C-style path quoting (`"a/caf\303\251.txt"`). */
function unquoteGitPath(p: string): string {
  if (!(p.startsWith('"') && p.endsWith('"'))) return p
  const inner = p.slice(1, -1)
  const bytes: number[] = []
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i] as string
    if (ch !== '\\') { bytes.push(...Buffer.from(ch, 'utf8')); continue }
    const next = inner[i + 1] ?? ''
    const oct = /^[0-7]{3}/.exec(inner.slice(i + 1))
    if (oct !== null) { bytes.push(parseInt(oct[0], 8)); i += 3; continue }
    const esc: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 }
    bytes.push(esc[next] ?? next.charCodeAt(0))
    i += 1
  }
  return Buffer.from(bytes).toString('utf8')
}

/**
 * The lines a unified diff adds or removes, per file, without their `+`/`-`.
 *
 * A file's header block runs from `diff --git` to its first `@@`; only there
 * are `--- a/…` and `+++ b/…` path lines. Inside a hunk every line starts
 * with ` `, `+`, `-` or `\`, so content that itself begins `---`/`+++` is
 * never mistaken for a header. A deleted file (`+++ /dev/null`) is keyed by
 * its old path, so its removed lines are still attributed to it.
 */
export function changedLinesByFile(diff: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let oldPath: string | undefined
  let current: string | undefined
  let inHunk = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      oldPath = undefined
      current = undefined
      inHunk = false
      continue
    }
    if (!inHunk) {
      if (line.startsWith('--- ')) {
        const p = line.slice(4)
        oldPath = p === '/dev/null' ? undefined : unquoteGitPath(p).replace(/^a\//, '')
      } else if (line.startsWith('+++ ')) {
        const p = line.slice(4)
        current = p === '/dev/null' ? oldPath : unquoteGitPath(p).replace(/^b\//, '')
      } else if (line.startsWith('@@')) {
        inHunk = true
      }
      continue
    }
    if (line.startsWith('@@')) continue
    if (current === undefined) continue
    if (line.startsWith('+') || line.startsWith('-')) {
      const list = out.get(current) ?? []
      list.push(line.slice(1))
      out.set(current, list)
    }
  }
  return out
}

/** One review on a pull request, as `GET /repos/{r}/pulls/{n}/reviews`
 *  reports it, in the order GitHub returns them (oldest first). */
export interface PrReview {
  login: string | undefined
  state: string
  commitId: string | undefined
}

/**
 * The trust-anchor approvers who have signed off on `approvedSha`.
 *
 * A login counts only when its LATEST decisive review (APPROVED,
 * CHANGES_REQUESTED or DISMISSED — a later plain COMMENT does not withdraw an
 * approval, exactly as GitHub reads it) is APPROVED, on exactly
 * `approvedSha`, by someone in `TRUST_ANCHOR_APPROVERS` who is not the PR's
 * author. An approval of an earlier head does not carry forward: a push after
 * sign-off is a change nobody signed off on.
 */
export function trustAnchorApprovers(input: {
  reviews: readonly PrReview[]
  author: string | undefined
  approvedSha: string
}): string[] {
  const latest = new Map<string, PrReview>()
  for (const r of input.reviews) {
    if (r.login === undefined || r.login.length === 0) continue
    if (r.state !== 'APPROVED' && r.state !== 'CHANGES_REQUESTED' && r.state !== 'DISMISSED') continue
    latest.set(r.login, r)
  }
  return [...latest.values()]
    .filter((r) => r.state === 'APPROVED' && r.commitId === input.approvedSha)
    .map((r) => r.login as string)
    .filter((l) => l !== input.author && TRUST_ANCHOR_APPROVERS.includes(l))
    .sort()
}

// ---------------------------------------------------------------------------
// The refusal text. One prefix per class, stable, and matched by trace.ts.
// ---------------------------------------------------------------------------

export const SECRET_REASON_PREFIX = 'touched never-write paths'
export const TRUST_ANCHOR_REASON_PREFIX = 'touched trust-anchor files'

export interface WriteFinding {
  file: string
  /** Starts with "its …" / "it is …": reads after the file name. */
  why: string
}

const listFindings = (findings: readonly WriteFinding[]): string =>
  findings.map((f) => `${f.file} (${f.why})`).join('; ')

/** The refusal for the secret class. Names the class, then every file with
 *  the fact that decided it, so "a real key" and "a `*.pem` the parser could
 *  not vouch for" never read the same. */
export function secretRefusal(findings: readonly WriteFinding[]): string {
  const keyInContent = findings.some((f) => f.why.startsWith(CONTENT_KEY_WHY))
  return `${SECRET_REASON_PREFIX} — secret material, never agent-writable and not clearable by any approval: ` +
    `${listFindings(findings)}` +
    (keyInContent ? '. A test key must be generated at test time, never committed' : '')
}

/**
 * The refusal for the trust-anchor class: what each file anchors, whose
 * approval clears it, on which commit, and what to do next. `approvers` is
 * `undefined` when the PR's reviews could not be read at all — said so,
 * because "could not ask" is not "nobody approved".
 */
export function trustAnchorRefusal(
  findings: readonly WriteFinding[],
  commit: string,
  approvers: readonly string[] | undefined,
): string {
  const who = TRUST_ANCHOR_APPROVERS.join(', ')
  const state = approvers === undefined
    ? `This PR's reviews could not be read, so no approval of ${commit} could be confirmed (fails closed)`
    : `No APPROVED review from a trust-anchor approver (${who}) is on ${commit}`
  return `${TRUST_ANCHOR_REASON_PREFIX} — a shipped client's TLS trust decision, which lands only with a human ` +
    `sign-off: ${listFindings(findings)}. ${state}. A wrong value here disconnects every installed client and ` +
    'only a client release can undo it, so no automated review clears it: a human checks the change, approves ' +
    'this exact head, and re-requests review from llamenos-auto'
}
