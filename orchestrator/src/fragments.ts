import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export interface LaneScope {
  owned: string[]
  notOwned: string[]
}

/**
 * Fragment authors write the "Owned paths" / "Does NOT own" sections in two
 * shapes, both of which appear in the real `.claude/agents/fragments/*.md`
 * files:
 *   - bulleted-block: the heading sits alone on its own line, and each path
 *     underneath is a `- \`path\`` bullet (ios, android, desktop, backend,
 *     shared, infra all use this for "Owned paths").
 *   - inline: heading and paths share one line, comma-separated, with free
 *     prose (typically the owning lane's name in parens) trailing after the
 *     last path — e.g. desktop's and backend's "Does NOT own" lines.
 * A parser that only handles the bulleted-block shape silently produces an
 * empty `notOwned` for every real lane, because both real "Does NOT own"
 * lines are inline. That was exactly the bug: desktop's owned `tests/` then
 * looked unqualified, overlapping backend's `tests/features/`/`tests/steps/`
 * — the write-collision this whole scope system exists to prevent. A bullet
 * or an inline heading can also list MORE than one backticked path on a
 * single line (e.g. infra's `Dockerfile*`, `knope.toml`, `Caddyfile*`), so
 * every backtick span on a line is a candidate, never just the first.
 *
 * Not every backtick span is a path, though: backend's sip-bridge bullet is
 * `` `apps/sip-bridge/` — ... (`PBX_TYPE` selects ARI/ESL/Kamailio) `` — the
 * second span is an env var name mentioned in the description, not a path.
 * Backtick spans are kept only when they look path-shaped (contain `/`, `.`,
 * or `*`); a bare identifier like `PBX_TYPE` has none of those and is
 * dropped. Every genuine path in the current fragments contains at least
 * one, so this does not lose real scope.
 *
 * New fragment authors: keep the heading on its own line if you want a
 * multi-bullet list below it, or put the heading and all paths on one line
 * if the whole section is one line — mixing (heading + one inline path, then
 * more bullets below) is not a shape this parser recognizes and will drop
 * the later bullets silently. And any backticked path must contain `/`, `.`,
 * or `*` or it will be silently treated as prose, not scope.
 *
 * To own ONE file at the top level, write it with a leading slash —
 * `/README.md`, not `README.md`. A bare name is a basename pattern and matches
 * that name at every depth in the tree; see `matchesPath` and #1473.
 */
const OWNED_HEADING = /^\*\*Owned paths:?\*\*\s*(.*)$/
const NOT_OWNED_HEADING = /^\*\*Does NOT own:?\*\*\s*(.*)$/i
const HEADING_LINE = /^\*\*/
const BULLET_LINE = /^[-*]\s+(.*)$/

/** A path-shaped backtick span has a directory separator, a file extension,
 *  or a glob star; a bare word like `PBX_TYPE` has none. */
function looksLikePath(s: string): boolean {
  return /[/.*]/.test(s)
}

function extractBackticks(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    if (m[1] && looksLikePath(m[1])) out.push(m[1])
  }
  return out
}

function collectSection(lines: string[], startIdx: number): string[] {
  const out: string[] = []
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const t = line.trim()
    if (HEADING_LINE.test(t)) break
    const bm = BULLET_LINE.exec(t)
    if (!bm) continue
    out.push(...extractBackticks(bm[1] ?? ''))
  }
  return out
}

/**
 * The scope breaker compares a worker's diff against these paths. They come
 * from the same fragment that briefs the worker, so a lane cannot be told it
 * owns something the breaker will then reject — the drift the reference
 * system (atlas-orchestrator, in the `translatemd` repo) could not prevent,
 * because there scope lived in config and ownership lived in prompt text.
 */
export function parseOwnedPaths(markdown: string): LaneScope {
  const lines = markdown.split('\n')
  let owned: string[] = []
  let notOwned: string[] = []
  lines.forEach((line, i) => {
    const t = line.trim()
    const ownedMatch = OWNED_HEADING.exec(t)
    const notOwnedMatch = NOT_OWNED_HEADING.exec(t)
    if (ownedMatch) {
      const inline = ownedMatch[1]?.trim() ?? ''
      owned = inline ? extractBackticks(inline) : collectSection(lines, i)
    } else if (notOwnedMatch) {
      const inline = notOwnedMatch[1]?.trim() ?? ''
      notOwned = inline ? extractBackticks(inline) : collectSection(lines, i)
    }
  })
  return { owned, notOwned }
}

/** Turns a `*`-glob into an anchored RegExp where `*` matches within one path
 *  segment only, never across `/` — a glob owned-path like `ios*.yml` must
 *  not accidentally swallow a `/`. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*')
  return new RegExp(`^${escaped}$`)
}

/**
 * Owned-path patterns come straight from fragment prose and take four
 * shapes: a directory (`apps/ios/`, trailing slash — matches everything
 * beneath it), a glob (`Dockerfile*`, `.github/workflows/ios*.yml` — `*`
 * matches within one path segment, never across `/`), a bare filename with
 * no `/` at all (`.env`, `knope.toml` — matches that name at ANY depth, not
 * just at the repo root), or a literal/prefix path containing a `/` with no
 * wildcard. The scope breaker (Task 8's `checkScope`) used a bare
 * `startsWith`, which judges `.github/workflows/ios-e2e.yml` out-of-lane for
 * the ios lane that owns `.github/workflows/ios*.yml` — `*` was never
 * translated into anything a prefix check understands.
 *
 * The bare-filename case matters most for the never-write list: `.env` with
 * a plain `startsWith(file, '.env')` only ever caught a `.env` sitting at
 * the repo root, so a worker was free to write `apps/worker/config/.env` or
 * `deploy/docker/.env` — exactly the secrets file the list exists to block,
 * just one directory down. A pattern with no `/` is therefore compared
 * against the file's last path segment (its basename) instead of the whole
 * path: glob-matched if it contains `*`, otherwise `startsWith` on the
 * basename — which deliberately still over-blocks lookalikes like
 * `.environment` (a `.env`-prefixed basename). That over-block is the safe
 * direction for a deny list and is left as-is; it only ever makes the never-
 * write list MORE conservative, never less.
 */
export function matchesPath(file: string, pattern: string): boolean {
  // A LEADING `/` anchors the pattern to the repo root, and is the ONLY way to
  // express "this one file, at the top level" (#1473).
  //
  // Without it, a single-file grant is unsayable. A pattern with no `/` is a
  // basename pattern matched at ANY depth, so infra's `README.md` grant in
  // #1467 also handed it `apps/ios/README.md`, `packages/test-specs/README.md`
  // and 17 others — including a file the shared lane owns exclusively. Lane
  // scope decides which lane may SELF-MERGE a path, so that silently
  // transferred authority over other lanes' documentation; the review rejected
  // it on breadth, independent of those files being harmless documentation.
  // Adding a `/` to the pattern does not help either: `README.md/` reads as a
  // directory and `./README.md` matches nothing.
  //
  // Deliberately ADDITIVE. Bare `README.md` keeps its basename-prefix
  // behaviour, because that behaviour is load-bearing for the never-write list
  // (see `SECRET_PATH_PATTERNS` and `config.ts`): it is what makes `.env`,
  // `*.pem` and `id_ed25519` catch a secret at any depth, the way CODEOWNERS'
  // `**/.env` would. Narrowing basename matching globally to fix one grant
  // would have quietly widened what a worker may write. The defect was the
  // ABSENCE of an anchored alternative, not the presence of basename matching.
  if (pattern.startsWith('/')) {
    const rooted = pattern.slice(1)
    // A lone `/` is not "the whole repo": before the anchor existed it matched
    // nothing (no repo-relative path starts with `/`), and an empty pattern
    // here would make `startsWith('')` own every file. Keep it matching
    // nothing, so adding the anchor cannot widen any existing scope.
    if (rooted.length === 0) return false
    return matchesRootedPath(file, rooted)
  }
  if (!pattern.includes('/')) {
    const basename = file.slice(file.lastIndexOf('/') + 1)
    return pattern.includes('*') ? globToRegExp(pattern).test(basename) : basename.startsWith(pattern)
  }
  return matchesRootedPath(file, pattern)
}

/**
 * The three rules a path-shaped (non-basename) pattern has always used,
 * unchanged and now shared with the root-anchored form so both spell
 * "directory", "glob" and "literal prefix" identically: a trailing slash is a
 * directory, a `*` is a single-segment glob, anything else is a literal prefix.
 *
 * The prefix case means `/README.md` also matches a root `README.md.bak`,
 * exactly as `docs/QUICKSTART.md` already matches `docs/QUICKSTART.md.bak`.
 * That is the pre-existing behaviour of every slash-bearing owned path, kept
 * on purpose rather than tightened here: whether a dotted pattern should
 * instead match exactly is a separate, riskier decision (#1473 raises it), and
 * making the anchored form behave differently from every other path pattern
 * would be a second semantics for readers to hold.
 */
function matchesRootedPath(file: string, pattern: string): boolean {
  if (pattern.endsWith('/')) {
    return file.startsWith(pattern)
  }
  if (!pattern.includes('*')) {
    return file.startsWith(pattern)
  }
  return globToRegExp(pattern).test(file)
}

/**
 * Suffixes that mark a file as a committed, secret-free TEMPLATE rather than
 * the secret it is a template OF.
 *
 * Why this list exists at all: `SECRET_PATH_PATTERNS`'s bare-filename entries
 * are prefix-matched against the basename (see `matchesPath`), deliberately,
 * so that `.env` also catches `.env.local` and `.env.production` — a real
 * secret under any environment name. That same prefix match also caught the
 * four `.env*.example` files and the `keystore.properties.example` that are
 * ALREADY TRACKED in this repo as documentation, which made every one of them
 * permanently unwritable by any lane (the `fleet/review` FAIL on #1253 —
 * "touched never-write paths: deploy/docker/.env.example"). A file whose
 * entire purpose is to be committed and read by an operator cannot be a
 * secret, and a deploy template nobody may edit is a deploy nobody may fix.
 *
 * Why a SUFFIX EXCLUSION and not a narrower pattern. The alternative was to
 * stop prefix-matching and instead enumerate what may follow `.env` — exact
 * `.env` plus `.env.<environment>` for a known set of environments. That
 * fails OPEN, and in the worst direction: the day someone adds `.env.prod`,
 * `.env.1984`, or `.env.flokinet` with real values, an enumeration that never
 * heard of that name simply does not match, and the guard waves a live secret
 * through in silence. The exclusion here fails CLOSED instead — anything that
 * does not literally end in one of these suffixes is still a secret, so every
 * environment name that will ever be invented is still caught by default, and
 * the only files that escape are ones explicitly labelled as placeholders.
 *
 * Deliberately narrow, and deliberately case-SENSITIVE (no `.toLowerCase()`):
 * `.env.Example` and `.env.EXAMPLE` stay forbidden. Every widening here is a
 * new spelling a secret can hide behind, so the list carries only the three
 * suffixes that have no other meaning anywhere, and `.gitleaks`-style content
 * scanning — a REQUIRED status check on every PR (`.github/workflows/
 * secret-scan.yml`) — remains the defence against a real credential pasted
 * INTO one of these templates. This is a path-shape gate; it never claimed to
 * read file contents, and the carve-out does not change which gate does.
 */
export const SECRET_TEMPLATE_SUFFIXES: readonly string[] = ['.example', '.sample', '.template']

/** True for a committed template — `deploy/docker/.env.example`, not
 *  `deploy/docker/.env`. The suffix must be a real suffix ON something: a
 *  file named exactly `.example` is not a template of anything. */
export function isSecretTemplatePath(file: string): boolean {
  const basename = file.slice(file.lastIndexOf('/') + 1)
  return SECRET_TEMPLATE_SUFFIXES.some((s) => basename.length > s.length && basename.endsWith(s))
}

/**
 * The ONLY secret patterns a committed template may be exempt from.
 *
 * Derived from evidence, not from a general rule: these are exactly the two
 * patterns that a template tracked in this repo actually matches. All five
 * tracked templates — `.env.example`, `.env.live.example`,
 * `apps/ios/fastlane/.env.example`, `deploy/docker/.env.example`,
 * `apps/android/keystore.properties.example` — fall under one of them.
 *
 * A NEW secret pattern does NOT get a carve-out. It gets one only when a
 * tracked template proves it needs one, and then only by being added here
 * deliberately. `tests/orchestrator/config.test.ts` enforces both directions
 * against the real tree: every tracked template must be covered by an entry
 * here, and every entry here must be justified by at least one tracked
 * template, so this list can neither silently under-cover nor rot into a
 * dead exemption.
 *
 * Concretely, this is why `.npmrc.example`, `id_rsa.example`,
 * `.dev.vars.example` and `authorized_keys.template` are still FORBIDDEN:
 * nothing in this repo needs them, so nothing exempts them.
 */
export const TEMPLATED_SECRET_PATTERNS: readonly string[] = ['.env', 'keystore.properties']

/**
 * The ONLY secret patterns a PUBLIC CERTIFICATE may be exempt from.
 *
 * The exact counterpart of `TEMPLATED_SECRET_PATTERNS` above, for the exact
 * same reason and with the exact same fail-closed discipline — read that
 * comment first; this one only states what differs.
 *
 * Why it exists: PEM is a CONTAINER format, not a secret. `*.pem` catches
 * private keys, but it equally catches public root CA certificates, CSRs,
 * public keys and DH parameters, none of which are secret. All three `.pem`
 * files tracked in this repo are public root CAs vendored for bundler
 * (`apps/ios/vendor/bundle/.../ssl_certs/`), so every one of them was
 * permanently unwritable by any lane — a `bundle update` that refreshes a
 * vendored cert was un-mergeable, and the failure arrived as
 * `NO-VERDICT:scope`, which reads like a scope violation rather than a false
 * positive (#1610).
 *
 * Derived from evidence, not from a general rule: `*.pem` is the only secret
 * pattern a public certificate tracked in this repo actually matches. A NEW
 * secret pattern does NOT get a carve-out; it gets one only when a tracked
 * public certificate proves it needs one, and then only by being added here
 * deliberately. `tests/orchestrator/config.test.ts` enforces both directions
 * against the real tree, so this list can neither silently under-cover nor
 * rot into a dead exemption. Concretely, this is why a `*.key` or `*.p12`
 * holding certificate bytes is still FORBIDDEN: nothing in this repo needs
 * it, so nothing exempts it.
 *
 * Why CONTENT and not a path rule. `.example` works as a path suffix because
 * the name itself says "template". A certificate's name does not:
 * `isrg-root-x2.pem` reads as a cert purely by convention, and nothing stops
 * a private key being called `server-cert.pem`. Any name-based rule here
 * fails OPEN in the one direction that matters. PEM makes the honest
 * discriminator explicit and machine-checkable, so `isPublicCertificateFile`
 * reads the bytes — see its own comment for the fail-closed rules, and
 * `matchesSecretPath` for what happens when no bytes are available (the file
 * stays a secret).
 */
export const CERTIFICATE_ONLY_PATTERNS: readonly string[] = ['*.pem']

/** Labels whose block body is public by construction. An allowlist, never a
 *  denylist: an unknown label is a label nobody analysed. */
const PUBLIC_PEM_LABELS: ReadonlySet<string> = new Set(['CERTIFICATE', 'PUBLIC KEY'])

/** RFC 7468 encapsulation boundaries, anchored and case-SENSITIVE. A
 *  lowercase or whitespace-padded boundary does not match, and therefore
 *  fails closed as "not parseable as PEM". */
const PEM_BEGIN = /^-----BEGIN ([A-Z0-9][A-Z0-9 ]*)-----$/
const PEM_END = /^-----END ([A-Z0-9][A-Z0-9 ]*)-----$/

/** A base64 body line. Non-empty, no whitespace, padding only at the end. */
const PEM_BODY = /^[A-Za-z0-9+/]+={0,2}$/

/** Printable US-ASCII plus tab/CR/LF. Anything else — a NUL, a DER blob, a
 *  UTF-8 replacement character from a binary file decoded as text — is not
 *  PEM and is refused before parsing. Written as a scan rather than a regex
 *  so the control characters stay out of a character class. */
function isPrintableAsciiText(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i)
    if (c === 0x09 || c === 0x0a || c === 0x0d) continue
    if (c < 0x20 || c > 0x7e) return false
  }
  return true
}

/**
 * True ONLY for a file that is, in its entirety, public certificate material.
 *
 * The content half of the `*.pem` carve-out. Every rule here is written to
 * fail CLOSED, because the cost of a false negative is "a vendored CA bundle
 * needs a one-line carve-out added" and the cost of a false positive is "a
 * private key becomes writable by a lane".
 *
 * Refused, each case deliberately:
 *
 * - `undefined` — the file could not be read at all. "Could not look" is
 *   never "is safe"; the caller gets no exemption rather than a guess.
 * - empty, or whitespace only — zero blocks is not "one or more blocks".
 * - any byte outside printable ASCII — binary, DER, or a mis-decoded blob.
 * - any line outside a block that is not blank. This refuses the common
 *   `openssl x509 -text` output with its human-readable preamble, on
 *   purpose: text outside the boundaries is content this function did not
 *   analyse, and a private key can be hidden in exactly that position in a
 *   way a block-only scan would never see.
 * - a BEGIN whose label is not in `PUBLIC_PEM_LABELS`, and separately and
 *   redundantly any label containing `PRIVATE KEY`. The allowlist already
 *   subsumes the second check; it is stated anyway so that widening the
 *   allowlist by accident cannot also admit `RSA PRIVATE KEY`.
 * - a BEGIN inside an open block, an END with no BEGIN, or an END whose
 *   label differs from the BEGIN it closes. Mismatched boundaries mean the
 *   file does not parse, and a mismatched pair is precisely how a block's
 *   real contents could be mislabelled.
 * - a file that ends with a block still open — the truncated-file case. A
 *   `BEGIN CERTIFICATE` followed by an unterminated second block is NOT one
 *   valid certificate plus some noise; it is a file that did not parse.
 * - a non-base64 line inside a block, including a blank one. RFC 1421-style
 *   in-block headers are not accepted either: they are not needed by any
 *   certificate this repo tracks, and accepting them is surface for nothing.
 *
 * Permitted only when: at least one block was parsed, every block closed,
 * and every label was public.
 */
export function isPublicCertificateFile(content: string | undefined): boolean {
  if (content === undefined) return false
  if (!isPrintableAsciiText(content)) return false

  let open: string | undefined
  let body = 0
  let blocks = 0
  for (const raw of content.split('\n')) {
    // Only trailing whitespace is tolerated (a CRLF file's `\r`). Leading
    // whitespace is not: an indented boundary is not a boundary.
    const line = raw.replace(/[ \t\r]+$/, '')

    if (open === undefined) {
      if (line.length === 0) continue
      const begin = PEM_BEGIN.exec(line)
      if (begin === null) return false
      const label = begin[1]
      if (label.includes('PRIVATE KEY')) return false
      if (!PUBLIC_PEM_LABELS.has(label)) return false
      open = label
      body = 0
      continue
    }

    const end = PEM_END.exec(line)
    if (end !== null) {
      // An empty block — BEGIN immediately followed by END — carries no
      // certificate at all. It is not a parse this function will vouch for.
      if (end[1] !== open || body === 0) return false
      open = undefined
      blocks += 1
      continue
    }
    if (!PEM_BODY.test(line)) return false
    body += 1
  }

  return open === undefined && blocks > 0
}

/**
 * `matchesPath` for the NEVER-WRITE gate specifically: the secret patterns,
 * minus committed templates, minus public certificates.
 *
 * Separate from `matchesPath` on purpose, rather than being folded into it.
 * `matchesPath` is also how lane OWNERSHIP is decided, and a lane that owns
 * `deploy/` must keep owning `deploy/docker/.env.example` — teaching the
 * general matcher that template files match nothing would make them
 * unowned-and-strayed instead of unowned-and-forbidden, which is the same
 * PR failing the same gate for a different stated reason. The carve-out is a
 * property of the secret deny list, so it lives in the secret matcher.
 *
 * TWO carve-outs, each scoped to its OWN pattern list, neither applied to
 * every secret pattern:
 *
 * 1. `TEMPLATED_SECRET_PATTERNS` — a committed template is not the secret it
 *    is a template of. Decided by the PATH, because the name says
 *    "template".
 * 2. `CERTIFICATE_ONLY_PATTERNS` — a public certificate is not a key.
 *    Decided by the CONTENT, because the name says nothing: a private key
 *    may be called `server-cert.pem`, so a path rule here would fail OPEN.
 *
 * Only patterns with a tracked file to justify one get a carve-out, and a
 * carve-out that buys nothing today is latent surface: the glob patterns
 * (`*.pem`, `*.key`, …) anchor their extension in `globToRegExp`, so
 * `ca.pem.example` never matched them and exempting them from the TEMPLATE
 * rule was already a no-op — but if `globToRegExp` were ever loosened, or a
 * directory-shaped secret pattern added, a blanket carve-out would silently
 * become load-bearing for patterns nobody analysed, and a
 * `server.key.example` holding a real key would become writable. The
 * fail-closed default is that a NEW pattern inherits no carve-out and
 * someone must justify adding one, which is the same reasoning that rejected
 * environment enumeration above.
 *
 * `contentOf` is OPTIONAL and the certificate carve-out is inert without it.
 * That is the fail-closed default, not an oversight: a caller that cannot
 * supply the bytes of the commit under judgement gets the pre-#1610
 * behaviour, where every `*.pem` is a secret. `verifyMechanical` (verify.ts)
 * supplies it from the base checkout — the head commit is fetched as an
 * object there, so `git show <head>:<path>` reads it without checking it out
 * or executing anything from it. A file that cannot be read (deleted in the
 * diff, unreadable, binary) yields `undefined` and stays forbidden.
 */
export function matchesSecretPath(
  file: string,
  pattern: string,
  contentOf?: (file: string) => string | undefined,
): boolean {
  if (!matchesPath(file, pattern)) return false
  if (TEMPLATED_SECRET_PATTERNS.includes(pattern) && isSecretTemplatePath(file)) return false
  if (
    contentOf !== undefined &&
    CERTIFICATE_ONLY_PATTERNS.includes(pattern) &&
    isPublicCertificateFile(contentOf(file))
  ) return false
  return true
}

export async function loadLaneScopes(repoRoot: string): Promise<Record<string, LaneScope>> {
  const dir = join(repoRoot, '.claude', 'agents', 'fragments')
  const files = await readdir(dir)
  const out: Record<string, LaneScope> = {}
  for (const f of files) {
    if (!f.endsWith('-supervisor.md')) continue
    const lane = f.replace(/-supervisor\.md$/, '')
    out[lane] = parseOwnedPaths(await readFile(join(dir, f), 'utf8'))
  }
  return out
}
