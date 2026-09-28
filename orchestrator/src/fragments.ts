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
  if (!pattern.includes('/')) {
    const basename = file.slice(file.lastIndexOf('/') + 1)
    return pattern.includes('*') ? globToRegExp(pattern).test(basename) : basename.startsWith(pattern)
  }
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
 * `matchesPath` for the NEVER-WRITE gate specifically: the secret patterns,
 * minus committed templates.
 *
 * Separate from `matchesPath` on purpose, rather than being folded into it.
 * `matchesPath` is also how lane OWNERSHIP is decided, and a lane that owns
 * `deploy/` must keep owning `deploy/docker/.env.example` — teaching the
 * general matcher that template files match nothing would make them
 * unowned-and-strayed instead of unowned-and-forbidden, which is the same
 * PR failing the same gate for a different stated reason. The carve-out is a
 * property of the secret deny list, so it lives in the secret matcher.
 *
 * Scoped to `TEMPLATED_SECRET_PATTERNS` — it is NOT applied to every secret
 * pattern. Only two patterns have a tracked template to justify one, and a
 * carve-out that buys nothing today is latent surface: the glob patterns
 * (`*.pem`, `*.key`, …) anchor their extension in `globToRegExp`, so
 * `ca.pem.example` never matched them and exempting them was already a
 * no-op — but if `globToRegExp` were ever loosened, or a directory-shaped
 * secret pattern added, a blanket carve-out would silently become
 * load-bearing for patterns nobody analysed, and a `server.key.example`
 * holding a real key would become writable. The fail-closed default is that
 * a NEW pattern inherits no carve-out and someone must justify adding one,
 * which is the same reasoning that rejected environment enumeration above.
 */
export function matchesSecretPath(file: string, pattern: string): boolean {
  if (!matchesPath(file, pattern)) return false
  if (!TEMPLATED_SECRET_PATTERNS.includes(pattern)) return true
  return !isSecretTemplatePath(file)
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
