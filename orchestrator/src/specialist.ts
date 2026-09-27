import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { REVIEW_JOB, headDirRefusal, verdictSummary, type CiContext, type CiVerdict } from './ci.js'
import { READ_ONLY_CONTRACT, VERDICT_CONTRACT, reviewFilesSection, type SecondOpinionResult } from './review.js'
import { diffHash, type CachedVerdict, type ReviewCache, type ReviewCacheKey } from './review-cache.js'

/**
 * Label-driven specialist reviewers (#1092).
 *
 * A PR label ending in `-reviewer` NAMES a specialist: the label
 * `crypto-security-reviewer` runs the agent defined at
 * `.claude/agents/crypto-security-reviewer.md`. The agent is derived from the
 * label, so a new specialist is an agent definition plus a label — never a
 * workflow change. The workflow (`fleet-specialist-review.yml`) fires on
 * `pull_request: [labeled]` ONLY, never `synchronize` (#812's quota burn);
 * re-requesting a specialist means re-applying its label.
 *
 * THE LABEL SELECTS CODE TO RUN, so it is an untrusted input and is resolved
 * against the agent registry of the trusted BASE checkout — fail closed:
 *   - it must match `SPECIALIST_NAME_RE` exactly (lowercase `[a-z0-9-]`,
 *     ending `-reviewer`, bounded length): no path separator, no `.`, no
 *     traversal, nothing a shell could interpret;
 *   - it must equal, byte for byte, the stem of a regular file in the
 *     registry directory LISTING (the path is never built from the label
 *     until the listing has produced a matching entry, and a symlink is
 *     refused);
 *   - that file's own frontmatter `name:` must equal the label too.
 * Anything else is a FAILED check with a stated reason — never a skip. A
 * specialist that silently does not run is worse than one that errors,
 * because the PR looks reviewed.
 *
 * The verdict posts as its own check, `fleet/review/<agent>`, which is NOT in
 * the ruleset's required contexts and must never be added there: a check that
 * only runs when a label is present would block every PR that never gets the
 * label, forever. It binds at the merge decision instead — see
 * `specialistRequirement` (folded into the required `fleet/review` gate) and
 * `specialistMergeBlockers` (the board and `review-and-merge`). Composition
 * rule: ANY FAIL FAILS — a specialist FAIL overrides a generalist PASS.
 */

export const SPECIALIST_LABEL_SUFFIX = '-reviewer'

/** Every specialist check is `fleet/review/<agent>` — a prefix of the
 *  generalist's own required name, so a human reading the checks list sees
 *  them together, and so `specialistMergeBlockers` can find all of them
 *  without a registry read. */
export const SPECIALIST_CHECK_PREFIX = `${REVIEW_JOB}/`

/** Relative to the trusted BASE checkout — never the head export, which has
 *  `.claude/` stripped anyway (`REVIEWER_CONTROL_NAMES`, review.ts). A PR that
 *  ADDS a specialist cannot use it until that definition has merged. */
export const AGENT_REGISTRY_DIR = '.claude/agents'

const SPECIALIST_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*-reviewer$/
const SPECIALIST_NAME_MAX = 64

/**
 * Mirrors the workflow's own job-level `if: endsWith(github.event.label.name,
 * '-reviewer')` — which is CASE-INSENSITIVE in Actions expressions. Mirrored
 * exactly so a label the workflow treats as a specialist request is never one
 * this module ignores: `Crypto-Security-REVIEWER` is a request here too, and
 * then fails `resolveSpecialistLabel`'s lowercase-only grammar, loudly.
 */
export function isSpecialistLabel(label: string): boolean {
  return label.toLowerCase().endsWith(SPECIALIST_LABEL_SUFFIX)
}

/** The check a specialist label posts under — built from the RAW label, the
 *  same expression the workflow's job `name:` uses, so a malformed label's
 *  FAIL lands under a name `specialistMergeBlockers` looks for. */
export function specialistCheckName(label: string): string {
  return `${SPECIALIST_CHECK_PREFIX}${label}`
}

export interface Specialist {
  agent: string
  /** The agent definition's body, frontmatter removed — the specialist's
   *  own instructions, read from the trusted base checkout. */
  instructions: string
}

export type SpecialistResolution = { ok: true; specialist: Specialist } | { ok: false; reason: string }

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/

/**
 * Resolves a `-reviewer` label to an agent definition in `registryDir`, or
 * refuses with a reason. See the module comment for every rule; each one is a
 * separate refusal so the failing check says exactly which rule the label
 * broke.
 */
export async function resolveSpecialistLabel(label: string, registryDir: string): Promise<SpecialistResolution> {
  if (!isSpecialistLabel(label)) {
    return { ok: false, reason: `label "${label}" does not end in "${SPECIALIST_LABEL_SUFFIX}" — not a specialist request` }
  }
  if (label.length > SPECIALIST_NAME_MAX || !SPECIALIST_NAME_RE.test(label)) {
    return {
      ok: false,
      reason: `label "${label}" is not a well-formed specialist name (lowercase [a-z0-9-], ending "${SPECIALIST_LABEL_SUFFIX}", ` +
        `at most ${SPECIALIST_NAME_MAX} characters) — refusing to derive an agent from it`,
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
      reason: `no agent definition "${fileName}" in the base checkout's ${registryDir} — unknown specialist "${label}". ` +
        'A new specialist must merge its agent definition before its label can run it.',
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
    return { ok: false, reason: `${registryDir}/${fileName} has an empty body — a specialist with no instructions is not a review` }
  }
  return { ok: true, specialist: { agent: label, instructions } }
}

/**
 * The specialist's prompt: its own agent definition first (the expertise),
 * then the SAME read-only and verdict contract the generalist gets
 * (review.ts), then the PR, the export path as data, and the diff.
 */
export function buildSpecialistPrompt(
  specialist: Specialist, pr: string, diff: string, changedFiles: readonly string[], exportDir: string,
): string {
  return `${specialist.instructions}\n\n` +
    '## How this review runs\n\n' +
    `You are the \`${specialist.agent}\` specialist reviewer for this pull request, requested by a human or ` +
    'an agent applying your label. You run IN ADDITION to the generalist non-author review, never instead ' +
    'of it: judge only what your expertise covers, and FAIL on any defect in that scope — a FAIL from you ' +
    'blocks the merge even when the generalist passed.\n\n' +
    `${READ_ONLY_CONTRACT}\n\n${VERDICT_CONTRACT}\n\n` +
    `## Pull request\n\n${pr}\n\n${reviewFilesSection(changedFiles, exportDir)}\n\n` +
    `## Diff\n\n\`\`\`diff\n${diff}\n\`\`\`\n`
}

// ---------------------------------------------------------------------------
// The specialist check itself — `llamenos-fleet specialist-review-ci`.
// ---------------------------------------------------------------------------

export interface SpecialistCiDeps {
  ctx: CiContext
  /** The label that fired this run — raw, untrusted. */
  label: string
  registryDir: string
  pathExists(p: string): boolean
  prDiff(): Promise<string>
  changedFiles(): Promise<string[]>
  /** The specialist's own cache namespace (`artifactReviewCache(..., agent)`).
   *  Only reached once the label has resolved, so the namespace is always a
   *  validated agent name. */
  cacheFor(agent: string): ReviewCache
  runEngine(input: { prompt: string; exportDir: string }): Promise<SecondOpinionResult>
  log(msg: string): void
}

/**
 * The same shape as `runReviewCi` (ci.ts), minus lane scope (that is
 * `fleet/verify`'s job, and the generalist's): refuse a `.git` in the export,
 * resolve the label (fail closed), reuse a cached PASS for this exact diff,
 * else run the engine read-only against the export and record a fresh PASS.
 * UNREADABLE and FAIL both fail — a specialist that could not run is not a
 * specialist that passed.
 */
export async function runSpecialistReviewCi(deps: SpecialistCiDeps): Promise<CiVerdict> {
  const refusal = headDirRefusal(deps)
  if (refusal !== undefined) return refusal

  const resolved = await resolveSpecialistLabel(deps.label, deps.registryDir)
  if (!resolved.ok) return { ok: false, summary: `specialist refused: ${resolved.reason}` }
  const { specialist } = resolved

  const diff = await deps.prDiff()
  const cacheKey: ReviewCacheKey = { pr: deps.ctx.pr, diffHash: diffHash(diff) }
  const cache = deps.cacheFor(specialist.agent)
  let cached: CachedVerdict | undefined
  try {
    cached = await cache.lookup(cacheKey)
  } catch (e) {
    deps.log(`${specialist.agent} cache lookup threw — running the engine (fail safe): ${e instanceof Error ? e.message : String(e)}`)
    cached = undefined
  }
  if (cached !== undefined) {
    deps.log(`${specialist.agent}: reused PASS for pr=${cacheKey.pr} sha256:${cacheKey.diffHash.slice(0, 12)}… — no engine call`)
    return { ok: true, summary: cached.text }
  }

  const changedFiles = await deps.changedFiles()
  let result: SecondOpinionResult
  try {
    result = await deps.runEngine({
      prompt: buildSpecialistPrompt(specialist, deps.ctx.pr, diff, changedFiles, deps.ctx.headDir),
      exportDir: deps.ctx.headDir,
    })
  } catch (e) {
    return { ok: false, summary: `${specialist.agent} unavailable: ${e instanceof Error ? e.message : String(e)}` }
  }

  const unreadablePrefix = result.failureKind === 'engine-misconfigured'
    ? `${specialist.agent} misconfigured`
    : `${specialist.agent} unavailable`
  const summary = result.verdict === 'UNREADABLE'
    ? `${unreadablePrefix}: ${verdictSummary(result.text)}`
    : verdictSummary(result.text)
  const verdict: CiVerdict = { ok: result.verdict === 'PASS', summary: `${summary}\n\n${result.text}` }

  // Only a fresh PASS is recorded — a FAIL is never reused (review-cache.ts).
  if (verdict.ok) {
    try {
      await cache.record(cacheKey, { verdict: 'PASS', text: verdict.summary })
    } catch (e) {
      deps.log(`${specialist.agent} cache record failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return verdict
}

// ---------------------------------------------------------------------------
// Binding, part 1 — the required `fleet/review` gate demands every requested
// specialist's PASS for this exact diff.
// ---------------------------------------------------------------------------

export interface SpecialistRequirementDeps {
  /** The PR's labels, read live — `undefined` when they could not be read. */
  labels: string[] | undefined
  resolve(label: string): Promise<SpecialistResolution>
  cacheFor(agent: string): ReviewCache
}

/**
 * Every requested specialist that has NOT passed on this diff, as reasons —
 * empty means every one has. A `-reviewer` label on the PR is a request;
 * the proof it was honoured is the specialist's own PASS record for this
 * `(pr, diffHash)` (the diff-content cache), which is why a rebase that leaves
 * the diff unchanged still satisfies it and a real change does not.
 *
 * Fail CLOSED in every direction the generalist's own cache fails open: the
 * generalist treats an unanswerable lookup as "run the engine", but here there
 * is no engine to run — an unanswerable lookup, an unreadable label list, or
 * a label that does not resolve can only mean "not proven", never "passed".
 */
export async function specialistRequirement(
  cacheKey: ReviewCacheKey, deps: SpecialistRequirementDeps,
): Promise<string[]> {
  if (deps.labels === undefined) return ['the PR\'s labels could not be read, so its requested specialists are unknown']
  const unmet: string[] = []
  for (const label of deps.labels.filter(isSpecialistLabel)) {
    const resolved = await deps.resolve(label)
    if (!resolved.ok) {
      unmet.push(`label "${label}": ${resolved.reason} — remove the label`)
      continue
    }
    const { agent } = resolved.specialist
    let hit: CachedVerdict | undefined
    try {
      hit = await deps.cacheFor(agent).lookup(cacheKey)
    } catch {
      hit = undefined
    }
    if (hit === undefined) {
      unmet.push(
        `${specialistCheckName(agent)} has no PASS for this diff (sha256:${cacheKey.diffHash.slice(0, 12)}…) — ` +
        `re-apply the "${agent}" label, wait for it to pass, then re-apply "review"`,
      )
    }
  }
  return unmet
}

// ---------------------------------------------------------------------------
// Binding, part 2 — the merge decision (board, review-and-merge).
// ---------------------------------------------------------------------------

export type SpecialistCheckState = 'PASS' | 'FAIL' | 'PENDING'
export interface SpecialistCheck { name: string; state: SpecialistCheckState }

export interface SpecialistBlockers {
  failing: string[]
  pending: string[]
  /** Requested by label, with no check at all on this head — a push since the
   *  label was applied, or a run that never started. */
  missing: string[]
}

export function hasSpecialistBlockers(b: SpecialistBlockers): boolean {
  return b.failing.length > 0 || b.pending.length > 0 || b.missing.length > 0
}

/**
 * Pure. `checksOnHead` must already be filtered to the PR's CURRENT head
 * commit. Every `fleet/review/*` check counts, requested or not; several
 * same-named runs resolve to the WORST of them (the board's own rule for
 * required contexts), so a FAIL can never hide behind a later PASS on the same
 * head — clearing a specialist FAIL takes a new head, which a fix is anyway.
 */
export function specialistMergeBlockers(checksOnHead: readonly SpecialistCheck[], labels: readonly string[]): SpecialistBlockers {
  const byName = new Map<string, SpecialistCheckState>()
  for (const c of checksOnHead) {
    if (!c.name.startsWith(SPECIALIST_CHECK_PREFIX)) continue
    const prev = byName.get(c.name)
    const worst = prev === 'FAIL' || c.state === 'FAIL' ? 'FAIL'
      : prev === 'PENDING' || c.state === 'PENDING' ? 'PENDING'
      : 'PASS'
    byName.set(c.name, worst)
  }
  const failing = [...byName].filter(([, s]) => s === 'FAIL').map(([n]) => n).sort()
  const pending = [...byName].filter(([, s]) => s === 'PENDING').map(([n]) => n).sort()
  const missing = labels.filter(isSpecialistLabel).map(specialistCheckName).filter((n) => !byName.has(n)).sort()
  return { failing, pending, missing }
}

export function describeSpecialistBlockers(b: SpecialistBlockers): string {
  const parts: string[] = []
  if (b.failing.length > 0) parts.push(`specialist review failed: ${b.failing.join(', ')}`)
  if (b.pending.length > 0) parts.push(`specialist review in flight: ${b.pending.join(', ')}`)
  if (b.missing.length > 0) parts.push(`specialist review requested but not run on this head (re-apply the label): ${b.missing.join(', ')}`)
  return parts.join('; ')
}
