import {
  CERTIFICATE_ONLY_PATTERNS, matchesPath, matchesSecretPath, publicCertificateVerdict,
} from './fragments.js'
import { SECRET_PATH_PATTERNS, TRUST_ANCHOR_APPROVERS, TRUST_ANCHOR_FILES, type TrustAnchorFile } from './config.js'
import { findPrivateKeyMaterial, latin1, textViews } from './key-material.js'
import { xcodegenTrustFinding } from './xcodegen-trust.js'

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
 *    client accepts (`TRUST_ANCHOR_FILES`), or a change to a trust line in
 *    any other shipped client file (`TRUST_SIGNATURES`, `trustProjection`).
 *    Writable, but it lands only once a human in `TRUST_ANCHOR_APPROVERS` has
 *    signed off on the exact commit under judgement (`trustAnchorApprovers`). A pin list is source code, not a key,
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
  // EVERY Android source set, not just `main/`: a `release/` (or flavour)
  // source set overrides `main/` resources in the build that ships, so a
  // `src/release/res/xml/network_security_config.xml` would replace the pin
  // set without touching the registered file. The non-shipping sets are
  // excluded by `ANDROID_NON_SHIPPING_SOURCE_SET` below.
  'apps/android/app/src/',
  // The Android build script decides which manifest, resources and
  // BuildConfig values ship, so a pin injected or a config swapped there ships.
  'apps/android/app/build.gradle.kts',
  'apps/ios/Sources/',
  // XcodeGen adds every file under a target's source paths to the build, so
  // the app target's `Resources/` paths ship exactly as `Sources/` does — a
  // `.swift` file dropped in `Resources/Fonts` is compiled into the app.
  'apps/ios/Resources/',
  // XcodeGen's spec writes Info.plist keys — App Transport Security included —
  // and says which sources and which Info.plist the app is built from.
  'apps/ios/project.yml',
  'apps/desktop/src/',
]

/**
 * The Android source sets that never reach an installed release build, by
 * EXACT name: unit and instrumentation tests (each, and per declared build
 * type), test fixtures, and the `debug` build type (`src/debug/` carries its
 * own pin-free `network_security_config.xml` by design). An allowlist of
 * exclusions, never a prefix: a product flavour called `debugger` or
 * `testing` ships, so it is shipped source. Every other set — `release`, a
 * flavour, a flavour+release combination — ships. The build types are the
 * two `apps/android/app/build.gradle.kts` declares; a new one ships until it
 * is deliberately added here.
 */
const ANDROID_NON_SHIPPING_SOURCE_SETS: ReadonlySet<string> = new Set([
  'test', 'androidTest', 'testFixtures', 'debug',
  'testDebug', 'testRelease', 'androidTestDebug', 'androidTestRelease',
])

const ANDROID_SRC = 'apps/android/app/src/'

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
 * registered files and a handful of named call sites contain any of them,
 * so an ordinary client change does not trip this.
 *
 * Deliberately NOT here: TLS library versions and features in `Cargo.toml`
 * or Gradle dependency blocks. A `rustls` bump is a supply-chain change with
 * its own gate (lockfiles, CODEOWNERS on manifests), not a change to which
 * certificates the client accepts.
 */
export const TRUST_SIGNATURES: readonly TrustSignature[] = [
  { name: 'an SPKI pin literal (sha256/…)', re: /sha256\/[A-Za-z0-9+/]{43}=/ },
  {
    // The manifest's `networkSecurityConfig` pointer is as load-bearing as the
    // file it points at: deleting it silently drops every pin.
    // The element itself, too: an override config with no pins at all is the
    // shortest way to drop them.
    name: 'an Android network-security setting',
    re: /<(network-security-config|pin-set|pin\b|trust-anchors|certificates\b)|networkSecurityConfig|usesCleartextTraffic|cleartextTrafficPermitted/,
  },
  {
    name: 'an OkHttp/JSSE trust hook',
    re: /CertificatePinner|certificatePinner\(|X509\w*TrustManager|TrustManagerFactory|SSLContext|SSLSocketFactory|sslSocketFactory\(|HostnameVerifier|hostnameVerifier\(/,
  },
  {
    name: 'an Apple Security trust API or App Transport Security key',
    re: /\bSecTrust[A-Za-z]*|serverTrust|CertificatePinValidator|CertificatePins|NSAppTransportSecurity|NSAllowsArbitraryLoads|NSExceptionDomains|NSPinnedDomains/,
  },
  {
    name: 'a rustls/reqwest trust hook',
    re: /ServerCertVerifier|RootCertStore|danger_accept_invalid|add_root_certificate|tls_built_in_root_certs|\.dangerous\(\)|with_custom_certificate_verifier|ClientConfig::builder|\bwebpki|rustls::|cert_pin::/,
  },
  { name: 'a SIP TLS trust anchor', re: /[Tt]lsTrustAnchor/ },
  {
    // Indirection: which manifest, resource directories and Info.plist the
    // shipped build is made from. Re-pointing one swaps every setting above
    // without changing a line that names them.
    name: 'a build-wiring setting that chooses what ships',
    re: new RegExp([
      // Gradle: source sets, the variants they belong to, and injected values.
      // (XcodeGen's `project.yml` is registered with a structural content rule
      // instead, `xcodegenTrustFinding`: YAML is not line-shaped, so no line
      // rule could read it faithfully.)
      'sourceSets', 'srcDirs?\\(', 'setSrcDirs', 'manifest\\.srcFile', 'manifestPlaceholders', 'resValue\\(',
      'buildTypes', 'productFlavors', 'flavorDimensions', 'initWith\\(',
    ].join('|')),
  },
]

export function trustAnchorEntry(file: string): TrustAnchorFile | undefined {
  return TRUST_ANCHOR_FILES.find((e) => e.path === file)
}

/** True when a registered file's verdict depends on its bytes at BOTH sides
 *  (a release-bump allowance or a content rule), so the caller must read its
 *  merge-base bytes as well as the head's. */
export function comparesBaseContent(entry: TrustAnchorFile): boolean {
  return entry.releaseBump !== undefined || entry.contentRule !== undefined
}

/** True for a file under `SHIPPED_CLIENT_SOURCE_ROOTS`. */
export function isShippedClientSource(file: string): boolean {
  if (file.startsWith(ANDROID_SRC)) {
    const set = file.slice(ANDROID_SRC.length).split('/')[0] ?? ''
    if (ANDROID_NON_SHIPPING_SOURCE_SETS.has(set)) return false
  }
  return SHIPPED_CLIENT_SOURCE_ROOTS.some((r) => matchesPath(file, r))
}

const MAX_QUOTED_LINE = 100

/** One trust signature line and the line after it, as `trustProjection`
 *  extracts them. */
interface TrustGroup {
  name: string
  line: string
  next: string
}

/**
 * The trust-relevant lines of a file: every line carrying a
 * `TRUST_SIGNATURES` match, each paired with the line that follows it.
 *
 * The following line is what makes this a projection of the trust DECISION
 * rather than of the keyword. A plist writes a key and its value on separate
 * lines — flipping `<key>NSAllowsArbitraryLoads</key>` from `<false/>` to
 * `<true/>` changes only the value line, which carries no signature at all —
 * and an XML attribute or a builder call can continue onto the next line the
 * same way. Pairing each signature with its successor puts that value inside
 * the projection, so it is compared.
 *
 * Read from BYTES (a latin1 view), not from diff hunks: a file git calls
 * binary has no hunks, and a trust decision must not become invisible just
 * because its file contains a NUL.
 */
export function trustProjection(content: FileContent | undefined): TrustGroup[] {
  if (content === undefined) return []
  const out: TrustGroup[] = []
  // Every text view of the bytes (key-material.ts's `textViews`): a UTF-16
  // re-encoding must not make a trust line vanish from the comparison.
  const views = typeof content === 'string' ? [content] : textViews(content)
  for (const view of views) {
    const lines = view.split('\n').map((l) => l.trim())
    lines.forEach((line, i) => {
      const sig = TRUST_SIGNATURES.find((s) => s.re.test(line))
      if (sig !== undefined) out.push({ name: sig.name, line, next: lines[i + 1] ?? '' })
    })
  }
  return out
}

/** The file's text with every knope version value replaced by a fixed
 *  token, so two sides that differ ONLY in that value compare equal. */
function maskReleaseVersions(text: string, bump: RegExp): string {
  const re = new RegExp(bump.source, bump.flags.includes('g') ? bump.flags : `${bump.flags}g`)
  return text.replace(re, (match: string, ...rest: unknown[]) => {
    const groups = rest.at(-1) as Record<string, string> | undefined
    const version = groups?.['version']
    return version === undefined ? match : match.replace(version, '<version>')
  })
}

/**
 * True when a registered file's only change is knope's release version bump.
 * Both sides must exist and the pattern must match on both — a file whose
 * version line was deleted or added is not "only a bump".
 */
function isOnlyReleaseBump(entry: TrustAnchorFile, before?: FileContent, after?: FileContent): boolean {
  if (entry.releaseBump === undefined || before === undefined || after === undefined) return false
  const a = asText(before)
  const b = asText(after)
  if (a === b || !entry.releaseBump.test(a) || !entry.releaseBump.test(b)) return false
  return maskReleaseVersions(a, entry.releaseBump) === maskReleaseVersions(b, entry.releaseBump)
}

const quote = (s: string): string => (s.length > MAX_QUOTED_LINE ? `${s.slice(0, MAX_QUOTED_LINE)}…` : s)

/**
 * Why changing `file` from `before` to `after` is a trust-anchor change, or
 * `undefined`. `before`/`after` are the file's bytes at the merge base and at
 * the head; `undefined` for a side where the file does not exist.
 *
 * A registered file is a trust anchor whatever changed — deleting or renaming
 * it included — unless it names a `contentRule`, which then decides (and holds
 * whatever it cannot read). Any other file under `SHIPPED_CLIENT_SOURCE_ROOTS` is one when
 * its `trustProjection` differs between the two sides: a trust line added,
 * removed, reordered, or its value changed. An edit that leaves every trust
 * line and its successor alone is not.
 */
export function trustAnchorFinding(file: string, before?: FileContent, after?: FileContent): string | undefined {
  const entry = trustAnchorEntry(file)
  if (entry !== undefined) {
    if (isOnlyReleaseBump(entry, before, after)) return undefined
    if (entry.contentRule === 'xcodegen-spec') {
      const why = xcodegenTrustFinding(before, after)
      return why === undefined ? undefined : `${why}; it is ${entry.anchors}`
    }
    return `it is ${entry.anchors}`
  }
  if (!isShippedClientSource(file)) return undefined
  const a = trustProjection(before)
  const b = trustProjection(after)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i]
    const y = b[i]
    if (x !== undefined && y !== undefined && x.line === y.line && x.next === y.next) continue
    const g = (y ?? x) as TrustGroup
    const shown = x !== undefined && y !== undefined && x.line === y.line
      ? `${g.line} ${x.next} → ${y.next}`
      : g.line
    return `its diff changes ${g.name} in shipped client source: \`${quote(shown)}\``
  }
  return undefined
}

/** One review on a pull request, as `GET /repos/{r}/pulls/{n}/reviews`
 *  reports it, in the order GitHub returns them (oldest first). */
export interface PrReview {
  login: string | undefined
  state: string
  commitId: string | undefined
}

/** One conversation comment on a pull request (`GET /repos/{r}/issues/{n}/comments`). */
export interface PrComment {
  login: string | undefined
  body: string
  /** Set when a GitHub App posted it — never a human's sign-off. */
  viaApp?: boolean
  /** Set when the comment was edited after it was posted (`updated_at` is
   *  later than `created_at`). An edited sign-off is refused: editing a
   *  stale sign-off to name a new head is exactly the shortcut that would
   *  turn "a human checked THIS commit" into "someone changed a number". */
  edited?: boolean
  /** Where it is, so the gate's log can name every sign-off it accepted. */
  url?: string
}

/**
 * The line a human writes to sign off on a trust-anchor change: exactly
 * `trust-anchor sign-off: <full 40-hex head SHA>`, alone on its line.
 *
 * Why a comment and not only an approval: in this repo `rhonda-rodododo`
 * opens every PR, fleet workers included, and GitHub forbids an author's
 * approval of their own PR — so an approval-only rule would make every
 * trust-anchor PR, #2550 first, permanently unlandable. The sign-off line
 * is a deliberate human statement that works whoever opened the PR.
 *
 * Why the FULL SHA: it binds the sign-off to one commit. A push moves the
 * head, the line no longer names it, and the change is held again. A short
 * SHA or the word "head" is refused.
 *
 * Anchored to a whole line, so prose that merely MENTIONS the format — the
 * gate's own refusal text, a brief, this comment — can never read as one.
 */
export const TRUST_ANCHOR_SIGN_OFF = /^[ \t]*trust-anchor sign-off:[ \t]*([0-9a-f]{40})[ \t]*$/gm

/** The commits `body` signs off on. */
export function signedOffShas(body: string): string[] {
  return [...body.matchAll(TRUST_ANCHOR_SIGN_OFF)].map((m) => m[1] as string)
}

/**
 * The trust-anchor approvers who have signed off on `approvedSha`, by either
 * of two human acts:
 *
 * 1. a sign-off line (`TRUST_ANCHOR_SIGN_OFF`) naming `approvedSha`, in a PR
 *    conversation comment written by an approver — the PR's author included,
 *    since that is who the operator is here. Never a comment a GitHub App
 *    posted, and never one that was EDITED after posting. Review bodies are
 *    not read: the REST API reports no edit time for them, so an edit there
 *    could not be refused.
 * 2. an APPROVED review of exactly `approvedSha` by an approver who is not
 *    the author (GitHub would not record the author's). A login counts only
 *    when its LATEST decisive review (APPROVED, CHANGES_REQUESTED or
 *    DISMISSED — a later plain COMMENT does not withdraw an approval, exactly
 *    as GitHub reads it) is that approval.
 *
 * Either way the sign-off names one commit, and a push after it is a change
 * nobody signed off on.
 */
/** The comments that ARE valid sign-offs on `approvedSha` — the same rule
 *  `trustAnchorApprovers` applies, exposed so the caller can log each one it
 *  accepted (a sign-off nobody can see is a defence nobody can audit). */
export function signOffComments(comments: readonly PrComment[], approvedSha: string): PrComment[] {
  return comments.filter((c) =>
    c.login !== undefined && TRUST_ANCHOR_APPROVERS.includes(c.login) && c.viaApp !== true && c.edited !== true &&
    signedOffShas(c.body).includes(approvedSha))
}

export function trustAnchorApprovers(input: {
  reviews: readonly PrReview[]
  comments?: readonly PrComment[]
  author: string | undefined
  approvedSha: string
}): string[] {
  const approvers = new Set<string>()
  const isApprover = (l: string | undefined): l is string => l !== undefined && TRUST_ANCHOR_APPROVERS.includes(l)

  for (const c of signOffComments(input.comments ?? [], input.approvedSha)) approvers.add(c.login as string)

  const latest = new Map<string, PrReview>()
  for (const r of input.reviews) {
    if (r.login === undefined || r.login.length === 0) continue
    if (r.state !== 'APPROVED' && r.state !== 'CHANGES_REQUESTED' && r.state !== 'DISMISSED') continue
    latest.set(r.login, r)
  }
  for (const r of latest.values()) {
    if (r.state === 'APPROVED' && r.commitId === input.approvedSha && r.login !== input.author && isApprover(r.login)) {
      approvers.add(r.login)
    }
  }
  return [...approvers].sort()
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
    ? `This PR's reviews and comments could not be read, so no sign-off on ${commit} could be confirmed (fails closed)`
    : `No trust-anchor approver (${who}) has signed off on ${commit}`
  // The sign-off format is DESCRIBED, never written as a line on its own:
  // this text is published in check output and review reports, and must not
  // itself parse as a sign-off (`TRUST_ANCHOR_SIGN_OFF` is line-anchored).
  return `${TRUST_ANCHOR_REASON_PREFIX} — a shipped client's TLS trust decision, which lands only with a human ` +
    `sign-off: ${listFindings(findings)}. ${state}. A wrong value here disconnects every installed client and ` +
    'only a client release can undo it, so no automated review clears it: a human checks the change, then posts ' +
    'a NEW, unedited PR comment with a line reading "trust-anchor sign-off:" followed by this full head SHA (or, ' +
    'when they did not open the PR, approves this exact head), and re-requests review from llamenos-auto'
}
