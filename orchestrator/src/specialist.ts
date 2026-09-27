import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { READ_ONLY_CONTRACT, VERDICT_CONTRACT, reviewFilesSection } from './review.js'

/**
 * Reviewer PROFILES — the registry half of `fleet/review` (#1158).
 *
 * One check, one job. `fleet-review.yml` fires when a review is REQUESTED
 * from `llamenos-auto` (or `rhonda-rodododo` on a release PR), works out
 * which reviews to run, runs them concurrently inside that one job, and
 * reports a single `fleet/review`. There is no `fleet/review/<agent>` check
 * any more and no label fires anything: #1092's per-specialist checks were
 * N jobs and N required-looking contexts for one decision, and a PR could
 * sit unmergeable behind `fleet/review/<agent> has no PASS for this diff`
 * with no path forward (#1086).
 *
 * This module resolves a PROFILE NAME to the agent definition that gives it
 * its expertise. A profile gets into the review set two ways:
 *   - a PR label naming it (`crypto-security-reviewer`) — the explicit ask,
 *     and the thing the job clears once that review has passed;
 *   - the PR's own content — a crypto diff gets the crypto review whether or
 *     not anyone remembered the label (`profilesFromContent`, ci.ts).
 *
 * A PROFILE NAME SELECTS CODE TO RUN, so it is untrusted wherever it comes
 * from and is resolved against the agent registry of the trusted BASE
 * checkout — fail closed:
 *   - it must match `REVIEWER_NAME_RE` exactly (lowercase `[a-z0-9-]`,
 *     ending `-reviewer`, bounded length): no path separator, no `.`, no
 *     traversal, nothing a shell could interpret;
 *   - it must equal, byte for byte, the stem of a regular file in the
 *     registry directory LISTING (the path is never built from the name
 *     until the listing has produced a matching entry, and a symlink is
 *     refused);
 *   - that file's own frontmatter `name:` must equal the name too.
 * Anything else FAILS `fleet/review` with the rule it broke — never a skip,
 * and never silently "no review needed". A reviewer that quietly does not
 * run is worse than one that errors, because the PR looks reviewed.
 */

export const REVIEWER_LABEL_SUFFIX = '-reviewer'

/** Relative to the trusted BASE checkout — never the head export, which has
 *  `.claude/` stripped anyway (`REVIEWER_CONTROL_NAMES`, review.ts). A PR that
 *  ADDS a reviewer profile cannot use it until that definition has merged. */
export const AGENT_REGISTRY_DIR = '.claude/agents'

const REVIEWER_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*-reviewer$/
const REVIEWER_NAME_MAX = 64

/**
 * Whether a PR label is asking for a reviewer profile at all. Deliberately
 * case-INSENSITIVE: `Crypto-Security-REVIEWER` is a request here, and then
 * fails `resolveReviewerLabel`'s lowercase-only grammar, loudly. A label the
 * repo uses for anything else (`crypto`, `security`, `lane:infra`) is simply
 * not a reviewer request and is left alone.
 */
export function isReviewerLabel(label: string): boolean {
  return label.toLowerCase().endsWith(REVIEWER_LABEL_SUFFIX)
}

export interface ReviewerProfile {
  agent: string
  /** The agent definition's body, frontmatter removed — the profile's own
   *  instructions, read from the trusted base checkout. */
  instructions: string
}

export type ReviewerResolution = { ok: true; profile: ReviewerProfile } | { ok: false; reason: string }

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/

/**
 * Resolves a reviewer profile NAME (a label, or one derived from the PR's
 * content) to an agent definition in `registryDir`, or refuses with a
 * reason. See the module comment for every rule; each one is a separate
 * refusal so the failing check says exactly which rule the name broke.
 */
export async function resolveReviewerLabel(label: string, registryDir: string): Promise<ReviewerResolution> {
  if (!isReviewerLabel(label)) {
    return { ok: false, reason: `"${label}" does not end in "${REVIEWER_LABEL_SUFFIX}" — not a reviewer profile` }
  }
  if (label.length > REVIEWER_NAME_MAX || !REVIEWER_NAME_RE.test(label)) {
    return {
      ok: false,
      reason: `"${label}" is not a well-formed reviewer profile name (lowercase [a-z0-9-], ending "${REVIEWER_LABEL_SUFFIX}", ` +
        `at most ${REVIEWER_NAME_MAX} characters) — refusing to derive an agent from it`,
    }
  }
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(registryDir, { withFileTypes: true })
  } catch (e) {
    return { ok: false, reason: `the agent registry ${registryDir} could not be read: ${e instanceof Error ? e.message : String(e)}` }
  }
  const fileName = `${label}.md`
  const entry = entries.find((e) => e.name === fileName)
  if (entry === undefined) {
    return {
      ok: false,
      reason: `no agent definition "${fileName}" in the base checkout's ${registryDir} — unknown reviewer profile "${label}". ` +
        'A new profile must merge its agent definition before anything can run it.',
    }
  }
  if (!entry.isFile()) {
    return { ok: false, reason: `${registryDir}/${fileName} is not a regular file (a symlink or directory) — refusing it` }
  }
  let text: string
  try {
    text = await readFile(join(registryDir, entry.name), 'utf8')
  } catch (e) {
    return { ok: false, reason: `${registryDir}/${fileName} could not be read: ${e instanceof Error ? e.message : String(e)}` }
  }
  const match = FRONTMATTER_RE.exec(text.replace(/\r\n/g, '\n'))
  if (match === null) {
    return { ok: false, reason: `${registryDir}/${fileName} has no frontmatter block — not an agent definition` }
  }
  const nameLine = (match[1] ?? '').split('\n').find((l) => l.startsWith('name:'))
  const declared = nameLine?.slice('name:'.length).trim()
  if (declared !== label) {
    return {
      ok: false,
      reason: `${registryDir}/${fileName} declares name "${declared ?? '(none)'}", not "${label}" — refusing a mismatched definition`,
    }
  }
  const instructions = (match[2] ?? '').trim()
  if (instructions.length === 0) {
    return { ok: false, reason: `${registryDir}/${fileName} has an empty body — a reviewer with no instructions is not a review` }
  }
  return { ok: true, profile: { agent: label, instructions } }
}

/**
 * A profile's prompt: its own agent definition first (the expertise), then
 * the SAME read-only and verdict contract the general reviewer gets
 * (review.ts), then the PR, the export path as data, and the diff.
 */
export function buildProfileReviewPrompt(
  profile: ReviewerProfile, pr: string, diff: string, changedFiles: readonly string[], exportDir: string,
): string {
  return `${profile.instructions}\n\n` +
    '## How this review runs\n\n' +
    `You are the \`${profile.agent}\` reviewer for this pull request. You run CONCURRENTLY WITH, and ` +
    'never instead of, the general non-author review: judge only what your expertise covers, and FAIL ' +
    'on any defect in that scope — a FAIL from you fails `fleet/review` even when every other reviewer ' +
    'passed.\n\n' +
    `${READ_ONLY_CONTRACT}\n\n${VERDICT_CONTRACT}\n\n` +
    `## Pull request\n\n${pr}\n\n${reviewFilesSection(changedFiles, exportDir)}\n\n` +
    `## Diff\n\n\`\`\`diff\n${diff}\n\`\`\`\n`
}
