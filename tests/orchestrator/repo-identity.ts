import { execFileSync } from 'node:child_process'

/**
 * Ground truth for "which repository is this?" — resolved from outside the
 * source tree, never from a literal inside it.
 *
 * This exists because of #1218. Rails in this suite compare an owner/repo path
 * against something else in the tree, and they were resolving
 * `${{ github.repository }}` through a hardcoded `'rhonda-rodododo/...'`
 * constant. After the org move to `Llamenos-Hotline` that constant and the
 * thing it was compared against were BOTH stale, so the comparison held and
 * the rail could not fail. A rail that cannot fail is worse than no rail: it
 * reports green over exactly the drift it was built to catch.
 *
 * Resolution order, and why each entry is trustworthy:
 *
 *  1. `GITHUB_REPOSITORY`. On a GitHub Actions runner this environment
 *     variable is, by definition, the same value the `${{ github.repository }}`
 *     expression expands to — so a rail that reads it is comparing against
 *     what the workflow will literally produce, not a guess at it. It is also
 *     the only source available under `fleet/verify`, which runs the suite
 *     from a `git archive | tar` export with no `.git` directory at all.
 *
 *  2. The checkout's own `origin` remote. The local-development path. A stale
 *     remote surfaces here as a loud failure, which is the correct outcome:
 *     a checkout still pointed at a redirect is itself the hazard #1218 is
 *     about.
 *
 * There is deliberately no third entry. Falling back to a literal is the
 * defect this module replaces.
 */
export function actualRepository(): string {
  const fromEnv = process.env['GITHUB_REPOSITORY']?.trim()
  if (fromEnv) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(fromEnv)) {
      throw new Error(`GITHUB_REPOSITORY is set but is not an owner/repo path: ${JSON.stringify(fromEnv)}`)
    }
    return fromEnv
  }

  let remoteUrl: string
  try {
    remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (e) {
    throw new Error(
      'cannot determine the repository this checkout belongs to: GITHUB_REPOSITORY is unset and ' +
        `\`git remote get-url origin\` failed (${e instanceof Error ? e.message : String(e)}). ` +
        'Refusing to assume a repository name — guessing one is what made these rails vacuous (#1218).',
    )
  }

  const parsed = parseRemoteUrl(remoteUrl)
  if (!parsed) throw new Error(`could not parse an owner/repo out of the origin remote: ${JSON.stringify(remoteUrl)}`)
  return parsed
}

/** Handles the three forms `git remote get-url` can return for GitHub:
 *  `https://github.com/o/r.git`, `git@github.com:o/r.git`, `ssh://git@github.com/o/r.git`. */
function parseRemoteUrl(url: string): string | undefined {
  const m = url.match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/)
  return m ? `${m[1]}/${m[2]}` : undefined
}
