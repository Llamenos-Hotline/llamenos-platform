/**
 * Which commits reach the user-facing release notes — the same rule knope
 * applies through `[package] scopes` in knope.toml, made inspectable.
 *
 * knope.toml's `scopes` is the single source of truth (an allowlist of
 * product scopes). This module never keeps a second list: it reads that one.
 *
 *   bun scripts/release/notes-scope.ts excluded <from-ref> [<to-ref>]
 *
 * prints, as Markdown, every changelog-eligible commit in <from-ref>..<to-ref>
 * (default HEAD) that the rule keeps OUT of the notes. knope-release-pr.yml
 * appends it to the release PR body so a product change filed under a scope
 * missing from the allowlist is seen at release review instead of vanishing.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const KNOPE_TOML = join(import.meta.dir, '..', '..', 'knope.toml')

/** Conventional-commit types knope turns into changelog entries. */
const CHANGELOG_TYPES = new Set(['feat', 'fix'])

export interface ConventionalSubject {
  type: string
  /** The scope exactly as written, or null for an unscoped commit. */
  scope: string | null
  breaking: boolean
  description: string
}

const SUBJECT = /^(?<type>[A-Za-z]+)(?:\((?<scope>[^()]*)\))?(?<bang>!)?: (?<description>.+)$/

export function parseSubject(subject: string): ConventionalSubject | null {
  const m = SUBJECT.exec(subject.trim())
  if (!m?.groups) return null
  const { type, scope, bang, description } = m.groups
  return {
    type: type.toLowerCase(),
    scope: scope === undefined ? null : scope,
    breaking: bang === '!',
    description,
  }
}

export function loadProductScopes(path: string = KNOPE_TOML): ReadonlySet<string> {
  const config = Bun.TOML.parse(readFileSync(path, 'utf8')) as { package?: { scopes?: unknown } }
  const scopes = config.package?.scopes
  if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every((s) => typeof s === 'string')) {
    throw new Error(`${path}: [package] scopes must be a non-empty array of strings`)
  }
  return new Set(scopes.map((s: string) => s.toLowerCase()))
}

/**
 * knope's scope rule: no scope → considered; otherwise the WHOLE scope string
 * must be in the allowlist (so `desktop,worker` is out even though both parts
 * are product scopes). Matching is case-insensitive, as knope's is.
 */
export function scopeIsProduct(scope: string | null, productScopes: ReadonlySet<string>): boolean {
  return scope === null || productScopes.has(scope.toLowerCase())
}

/** A commit that would produce a changelog entry if its scope were admitted. */
export function isChangelogEligible(c: ConventionalSubject): boolean {
  return CHANGELOG_TYPES.has(c.type) || c.breaking
}

export interface Excluded {
  sha: string
  subject: string
  scope: string
}

export function excludedCommits(
  commits: ReadonlyArray<{ sha: string; subject: string }>,
  productScopes: ReadonlySet<string>,
): Excluded[] {
  const out: Excluded[] = []
  for (const { sha, subject } of commits) {
    const c = parseSubject(subject)
    if (!c || !isChangelogEligible(c) || scopeIsProduct(c.scope, productScopes)) continue
    // scopeIsProduct(null) is true, so a commit reaching here has a scope.
    out.push({ sha, subject, scope: c.scope as string })
  }
  return out
}

export function renderExcluded(excluded: readonly Excluded[], range: string): string {
  const lines = [
    '### Left out of these notes (not a product scope)',
    '',
    `Commits in \`${range}\` that knope.toml's \`scopes\` allowlist keeps out of the changelog and the version bump. ` +
      'If one of these changed the product, its scope belongs in that allowlist (multi-scope commits are always left out).',
    '',
  ]
  if (excluded.length === 0) {
    lines.push('_None._')
  } else {
    for (const e of excluded) lines.push(`- \`${e.scope}\` — ${e.subject} (${e.sha.slice(0, 9)})`)
  }
  return lines.join('\n')
}

function gitLog(range: string): { sha: string; subject: string }[] {
  const r = Bun.spawnSync(['git', 'log', '--no-merges', '--format=%H%x00%s', range], { stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`git log ${range} failed: ${r.stderr.toString().trim()}`)
  return r.stdout
    .toString()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, subject] = line.split('\0')
      return { sha, subject }
    })
}

if (import.meta.main) {
  const [command, from, to = 'HEAD'] = process.argv.slice(2)
  if (command !== 'excluded' || !from) {
    console.error('usage: bun scripts/release/notes-scope.ts excluded <from-ref> [<to-ref>]')
    process.exit(2)
  }
  const range = `${from}..${to}`
  console.log(renderExcluded(excludedCommits(gitLog(range), loadProductScopes()), range))
}
